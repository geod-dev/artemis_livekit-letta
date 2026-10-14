import type { ImageContent } from '@letta-ai/letta-agent-sdk';
import { randomUUID } from 'node:crypto';
import { ATTACHMENT_PATH, registerAttachment, removeUnwrittenAttachment } from './attachment-retention';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChatAttachment } from '../../chat-types';
import { config } from '../config';

/**
 * The agent's workspace, shared with the Letta container (its working
 * directory there). Paths in the API, in turns and in the agent's replies are
 * relative to the workspace root. The backend keeps its own files under
 * `data/`; everything else belongs to the agent.
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
export const MAX_RECORDING_DURATION_MS = 5 * 60 * 1000;
/** Larger images stay on disk only: providers reject big inline images. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const ATTACHMENTS = 'data/attachments';

type ImageType = ImageContent['source']['media_type'];

/** Store app-owned attachment bytes in `data/attachments`; never use for user outputs. */
export async function saveAttachment(file: File): Promise<ChatAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('File is larger than 25 MB');
  const bytes = Buffer.from(await file.arrayBuffer());
  return saveAttachmentBytes(bytes, file.name, 'upload');
}

/** Store a bounded MCP artifact with metadata derived from its actual bytes. */
export async function saveMcpArtifact(input: {
  bytes: Uint8Array | Buffer;
  mimeType: string;
  name: string;
}): Promise<ChatAttachment> {
  if (!input || typeof input.name !== 'string' || typeof input.mimeType !== 'string') {
    throw new Error('Artifact metadata is invalid');
  }
  return saveAttachmentBytes(Buffer.from(input.bytes), input.name, 'mcp-output');
}

async function saveAttachmentBytes(
  bytes: Buffer,
  originalName: string,
  kind: 'upload' | 'mcp-output',
): Promise<ChatAttachment> {
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('File is larger than 25 MB');
  const path = `${ATTACHMENTS}/${randomUUID()}/${safeName(originalName)}`;
  const target = join(config.workspace.dir, path);
  await mkdir(dirname(target), { recursive: true });
  await registerAttachment(path, kind);
  try {
    await writeFile(target, bytes, { flag: 'wx' });
  } catch (error) {
    await removeUnwrittenAttachment(path).catch(() => {});
    throw error;
  }
  const image = imageType(bytes);
  const attachment = {
    path,
    name: safeName(originalName),
    kind: image ? 'image' : 'file',
    mimeType: inspectedMimeType(bytes),
    size: bytes.length,
  } satisfies ChatAttachment;
  return attachment;
}

/** Check the attachments of a turn, and load the images among them to show inline. */
export async function resolveAttachments(
  attachments: readonly ChatAttachment[]
): Promise<{ attachments: ChatAttachment[]; images: ImageContent[] }> {
  const resolved: ChatAttachment[] = [];
  const images: ImageContent[] = [];
  for (const a of attachments) {
    const file = ATTACHMENT_PATH.test(a.path) ? await workspaceFile(a.path) : null;
    if (!file) throw new Error(`Unknown attachment ${a.path}`);
    const bytes = file.size <= MAX_INLINE_IMAGE_BYTES ? await readFile(file.path) : null;
    const image = bytes && imageType(bytes);
    if (image)
      images.push({
        type: 'image',
        source: { type: 'base64', media_type: image, data: bytes.toString('base64') },
      });
    const detected = bytes ? inspectedMimeType(bytes) : await mimeTypeForFile(file.path);
    resolved.push({
      path: a.path,
      name: String(a.name || basename(a.path)).slice(0, 200),
      kind: detected.startsWith('image/') ? 'image' : 'file',
      mimeType: detected,
      size: file.size,
    });
  }
  return { attachments: resolved, images };
}

/**
 * A file in the workspace, by its workspace path. Null when the path names no
 * regular file or resolves (through `..` or links) outside the workspace.
 */
export async function workspaceFile(path: string): Promise<{
  path: string;
  size: number;
  contentType: string;
  viewable: boolean;
} | null> {
  const root = await realpath(config.workspace.dir).catch(() => null);
  if (!root) return null;
  const file = await realpath(resolve(root, path)).catch(() => null);
  if (!file) return null;
  const inside = relative(root, file);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return null;
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const prefix = await readPrefix(file, 8192);
  const type = fileType(file, prefix);
  return { path: file, size: info.size, ...type };
}

const TEXT = 'text/plain; charset=utf-8';

/** How a workspace file is served: its type, and whether a browser may show it. */
export function fileType(path: string, bytes: Uint8Array): { contentType: string; viewable: boolean } {
  const contentType = inspectedMimeType(bytes, path);
  const viewable = /^(image|audio|video)\//.test(contentType) || contentType === 'application/pdf' || contentType === 'application/json' || contentType.startsWith('text/');
  return { contentType, viewable };
}

/** Sniff a file's bytes; filenames and submitted MIME types do not determine it. */
export function inspectedMimeType(bytes: Uint8Array, _path = ''): string {
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('latin1');
  const image = imageType(bytes);
  if (image) return image;
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    return /^(M4A |M4B |M4P )$/.test(brand) ? 'audio/mp4' : 'video/mp4';
  }
  if (ascii(0, 4) === 'PK\x03\x04') return 'application/zip';
  if (isUtf8Text(bytes)) {
    try {
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return 'application/json';
    } catch {
      return TEXT;
    }
  }
  return 'application/octet-stream';
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.some((b) => b === 0)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

async function readPrefix(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function mimeTypeForFile(path: string): Promise<string> {
  return inspectedMimeType(await readPrefix(path, 8192), path);
}

/** The image types models read, recognized by their content. */
export function imageType(bytes: Uint8Array): ImageType | null {
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString('latin1');
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** A file name that is safe on disk and in a shell. */
function safeName(name: string): string {
  const clean = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*`$]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  return clean.slice(-120) || 'file';
}
