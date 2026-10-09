import type { ImageContent } from '@letta-ai/letta-agent-sdk';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChatAttachment } from '../chat-types';
import { config } from './config';

/**
 * The agent's workspace, shared with the Letta container (its working
 * directory there). Paths in the API, in turns and in the agent's replies are
 * relative to the workspace root. The backend keeps its own files under
 * `data/`; everything else belongs to the agent.
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Larger images stay on disk only: providers reject big inline images. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const ATTACHMENTS = 'data/attachments';
const ATTACHMENT_PATH =
  /^data\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/\\]+$/;

type ImageType = ImageContent['source']['media_type'];

/** Store an uploaded file as an attachment: `data/attachments/<uuid>/<file name>`. */
export async function saveAttachment(file: File): Promise<ChatAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('File is larger than 25 MB');
  const bytes = Buffer.from(await file.arrayBuffer());
  const path = `${ATTACHMENTS}/${randomUUID()}/${safeName(file.name)}`;
  const target = join(config.workspace.dir, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  const image = imageType(bytes);
  return {
    path,
    name: file.name || 'file',
    kind: image ? 'image' : 'file',
    mimeType: image ?? (file.type || undefined),
    size: bytes.length,
  };
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
    resolved.push({
      path: a.path,
      name: String(a.name || basename(a.path)).slice(0, 200),
      kind: a.kind === 'image' ? 'image' : 'file',
      ...(a.mimeType && /^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType) ? { mimeType: a.mimeType } : {}),
      size: file.size,
    });
  }
  return { attachments: resolved, images };
}

/**
 * A file in the workspace, by its workspace path. Null when the path names no
 * regular file or resolves (through `..` or links) outside the workspace.
 */
export async function workspaceFile(path: string): Promise<{ path: string; size: number } | null> {
  const root = await realpath(config.workspace.dir).catch(() => null);
  if (!root) return null;
  const file = await realpath(resolve(root, path)).catch(() => null);
  if (!file) return null;
  const inside = relative(root, file);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return null;
  }
  const info = await stat(file).catch(() => null);
  return info?.isFile() ? { path: file, size: info.size } : null;
}

const TEXT = 'text/plain; charset=utf-8';
/**
 * Content types by extension. Text formats, including markup and code, are
 * served as plain text, so a file the agent wrote never runs as a page.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ...Object.fromEntries(
    [
      '.txt',
      '.md',
      '.csv',
      '.tsv',
      '.json',
      '.jsonl',
      '.log',
      '.xml',
      '.html',
      '.css',
      '.yaml',
      '.yml',
      '.toml',
      '.ini',
      '.py',
      '.js',
      '.ts',
      '.sh',
      '.sql',
    ].map((ext) => [ext, TEXT])
  ),
};

/** How a workspace file is served: its type, and whether a browser may show it. */
export function fileType(path: string): { contentType: string; viewable: boolean } {
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const viewable =
    /^(image|audio|video)\//.test(contentType) ||
    contentType === 'application/pdf' ||
    contentType === TEXT;
  return { contentType, viewable };
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
