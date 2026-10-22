import type { ChatAttachment } from '@artemis/contracts/chat-types';
import { type ArtifactSink, type InlineImage, type InlineImageType, type McpCallResult } from '../client.ts';

/** Per binary result and per call in total (the old backend's cap). */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
/** Images up to this size are also inlined for the model. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

const INLINE_TYPES: ReadonlySet<string> = new Set<InlineImageType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
};
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Media {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}

/**
 * Turns an MCP `tools/call` result into the call result the bridge uses: binary
 * blocks (images, audio, resources) are saved through the `ArtifactSink`, the
 * envelope (structured content, metadata, errors) stays as text, and small images
 * are also inlined for the model. Port of backend/src/mcp-bridge/client.ts, with
 * workspace paths instead of gateway URLs and no retention markers.
 */
export class McpResultConverter {
  constructor(private readonly sink: ArtifactSink) {}

  async convert(raw: unknown, conversationId: string): Promise<McpCallResult> {
    const record = recordOf(raw) ?? {};
    const content: unknown[] = Array.isArray(record.content) ? [...record.content] : [];
    const envelope = { ...record, content };
    const artifacts: ChatAttachment[] = [];
    const images: InlineImage[] = [];
    let total = 0;

    for (const [index, block] of content.entries()) {
      const item = recordOf(block);
      const media = item ? mediaOf(item, index) : null;
      if (!item || !media) continue;
      total += media.bytes.length;
      if (total > MAX_ARTIFACT_BYTES) throw new Error('MCP artifacts exceed 25 MB in total');
      const attachment = await this.sink.save({
        conversationId,
        name: media.name,
        mimeType: media.mimeType,
        bytes: media.bytes,
      });
      artifacts.push(attachment);
      if (item.type === 'image' && INLINE_TYPES.has(media.mimeType) && media.bytes.length <= MAX_INLINE_IMAGE_BYTES) {
        images.push({
          mediaType: media.mimeType as InlineImageType,
          data: Buffer.from(media.bytes).toString('base64'),
        });
      }
      content[index] = withArtifact(item, attachment);
    }

    const saved = artifacts.map((attachment) => `Saved to ${attachment.path}`);
    return {
      text: [...saved, JSON.stringify(envelope, null, 2)].join('\n\n'),
      isError: record.isError === true,
      images,
      artifacts,
    };
  }

  /**
   * Device screenshots (`screenshot_capture` on a connected device): exactly one
   * PNG, saved under the device's name; everything else converts as usual.
   */
  async screenshot(raw: unknown, deviceName: string, conversationId: string): Promise<McpCallResult> {
    const record = recordOf(raw) ?? {};
    const content: unknown[] = Array.isArray(record.content) ? record.content : [];
    const shots = content.flatMap((block) => {
      const item = recordOf(block);
      return item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string'
        ? [{ block, data: item.data, mimeType: item.mimeType }]
        : [];
    });
    if (shots.length === 0) return this.convert(raw, conversationId);
    if (shots.length > 1) throw new Error('A screenshot result may contain only one image');
    const shot = shots[0]!;
    const bytes = shot.mimeType === 'image/png' ? decodeBase64(shot.data, 'Screenshot') : null;
    if (!bytes || bytes.length > MAX_SCREENSHOT_BYTES || !isPng(bytes)) {
      throw new Error('Screenshot must be a valid PNG of at most 10 MB');
    }

    const safeDevice = deviceName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'device';
    const attachment = await this.sink.save({
      conversationId,
      name: `${safeDevice}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
      mimeType: 'image/png',
      bytes,
    });
    const rest = await this.convert(
      { ...record, content: content.filter((block) => block !== shot.block) },
      conversationId
    );
    return {
      text: [`Screenshot from ${deviceName} saved to ${attachment.path}.`, rest.text].join('\n\n'),
      isError: rest.isError,
      images: [
        ...(bytes.length <= MAX_INLINE_IMAGE_BYTES ? [{ mediaType: 'image/png' as const, data: shot.data }] : []),
        ...rest.images,
      ],
      artifacts: [attachment, ...rest.artifacts],
    };
  }
}

function mediaOf(item: Record<string, unknown>, index: number): Media | null {
  if (item.type === 'image' || item.type === 'audio') {
    if (typeof item.data !== 'string' || typeof item.mimeType !== 'string') return null;
    return {
      bytes: decodeBase64(item.data, 'MCP media'),
      mimeType: item.mimeType,
      name: `mcp-${item.type}-${index + 1}${EXTENSIONS[item.mimeType] ?? ''}`,
    };
  }
  if (item.type === 'resource') {
    const resource = recordOf(item.resource);
    if (!resource) return null;
    const mimeType = typeof resource.mimeType === 'string' ? resource.mimeType : 'application/octet-stream';
    const uriName = typeof resource.uri === 'string' ? resource.uri.split('/').pop() : undefined;
    const name = uriName ? safeName(uriName) : `mcp-resource-${index + 1}`;
    if (typeof resource.blob === 'string') return { bytes: decodeBase64(resource.blob, 'MCP resource'), mimeType, name };
    if (typeof resource.text === 'string') {
      const bytes = Buffer.from(resource.text, 'utf8');
      if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error('MCP resource is larger than 25 MB');
      return { bytes, mimeType, name };
    }
  }
  return null;
}

/** The block as the model sees it: binary payload dropped, the saved artifact attached. */
function withArtifact(item: Record<string, unknown>, attachment: ChatAttachment): Record<string, unknown> {
  if (item.type === 'resource') {
    const resource = { ...recordOf(item.resource) };
    delete resource.blob;
    delete resource.text;
    return { ...item, resource: { ...resource, artifact: attachment } };
  }
  const copy: Record<string, unknown> = { ...item, artifact: attachment };
  delete copy.data;
  return copy;
}

export function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function decodeBase64(data: string, what: string): Buffer {
  if (data.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4 + 4 || !BASE64.test(data)) {
    throw new Error(`${what} must be valid base64 of at most 25 MB`);
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES) throw new Error(`${what} must be valid base64 of at most 25 MB`);
  return bytes;
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function safeName(name: string): string {
  return name.replace(/[\\/\0-\x1f<>:"|?*]/g, '_').slice(-120) || 'mcp-resource';
}
