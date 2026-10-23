/**
 * Content sniffing: a file's type is read from its bytes, never from its name or
 * a submitted MIME type. Pure functions, so any workspace consumer can use them.
 */
import type { ImageMediaType } from '@artemis/core';

export interface MediaSniff {
  /** IANA media type from the signature, or a text type for UTF-8 content. */
  mimeType: string;
  /** Short human label for messages, e.g. `PDF document`. Unknown types read `binary data`. */
  label: string;
}

const MEDIA_LABELS: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF document',
  'application/zip': 'zip archive (xlsx, docx, pptx, ...)',
  'application/json': 'JSON text',
  'text/plain; charset=utf-8': 'text',
  'audio/wav': 'WAV audio',
  'audio/ogg': 'Ogg audio',
  'audio/mp4': 'MPEG-4 media',
  'video/mp4': 'MPEG-4 media',
  'image/avif': 'AVIF image',
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/gif': 'GIF image',
  'image/webp': 'WebP image',
};

/** The image types models read, recognized by their content. */
export function imageType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Sniff a file's bytes; filenames and submitted MIME types do not determine it. */
export function inspectedMimeType(bytes: Uint8Array): string {
  const image = imageType(bytes);
  if (image) return image;
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(bytes, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))
    return 'audio/mpeg';
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    return /^(M4A |M4B |M4P )$/.test(brand) ? 'audio/mp4' : 'video/mp4';
  }
  if (ascii(bytes, 0, 4) === 'PK\x03\x04') return 'application/zip';
  if (isTextContent(bytes)) {
    try {
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return 'application/json';
    } catch {
      return 'text/plain; charset=utf-8';
    }
  }
  return 'application/octet-stream';
}

/** MIME type and label of a file, from its bytes. */
export function sniffMedia(bytes: Uint8Array): MediaSniff {
  const mimeType = inspectedMimeType(bytes);
  return { mimeType, label: MEDIA_LABELS[mimeType] ?? 'binary data' };
}

/** Text means valid UTF-8 without NUL or control characters (tab, newline and carriage return allowed). */
export function isTextContent(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString('latin1');
}
