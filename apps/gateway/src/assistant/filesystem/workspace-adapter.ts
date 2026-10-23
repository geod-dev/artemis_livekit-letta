import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChatAttachment } from '../../chat-types';
import { config } from '../config';
import { ATTACHMENT_PATH, registerAttachment, removeUnusedAttachment } from './attachment-retention';

/**
 * The agent's workspace, shared with the agent-server. Paths in the API and in
 * turns are relative to the workspace root. The gateway stores uploads under
 * `data/attachments`; the agent-server owns everything else under `data/`.
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
/** Larger files are not read to sniff their type; their name and size decide. */
const MAX_SNIFF_BYTES = 5 * 1024 * 1024;
const ATTACHMENTS = 'data/attachments';

type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Store an uploaded file in `data/attachments`, with metadata derived from its actual bytes. */
export async function saveAttachment(file: File): Promise<ChatAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('File is larger than 25 MB');
  const bytes = Buffer.from(await file.arrayBuffer());
  const name = safeName(file.name);
  const path = `${ATTACHMENTS}/${randomUUID()}/${name}`;
  const target = join(config.workspace.dir, path);
  await mkdir(dirname(target), { recursive: true });
  await registerAttachment(path);
  try {
    await writeFile(target, bytes, { flag: 'wx' });
  } catch (error) {
    await removeUnusedAttachment(path).catch(() => {});
    throw error;
  }
  return {
    path,
    name,
    kind: imageType(bytes) ? 'image' : 'file',
    mimeType: inspectedMimeType(bytes),
    size: bytes.length,
  } satisfies ChatAttachment;
}

/** Check the attachments of a turn against the workspace and report their inspected metadata. */
export async function resolveAttachments(attachments: readonly ChatAttachment[]): Promise<ChatAttachment[]> {
  const resolved: ChatAttachment[] = [];
  for (const a of attachments) {
    const file = ATTACHMENT_PATH.test(a.path) ? await workspaceFile(a.path) : null;
    if (!file) throw new Error(`Unknown attachment ${a.path}`);
    const bytes = file.size <= MAX_SNIFF_BYTES ? await readFile(file.path) : null;
    const detected = bytes ? inspectedMimeType(bytes) : await mimeTypeForFile(file.path);
    resolved.push({
      path: a.path,
      name: String(a.name || basename(a.path)).slice(0, 200),
      kind: detected.startsWith('image/') ? 'image' : 'file',
      mimeType: detected,
      size: file.size,
    });
  }
  return resolved;
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
function fileType(path: string, bytes: Uint8Array): { contentType: string; viewable: boolean } {
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
