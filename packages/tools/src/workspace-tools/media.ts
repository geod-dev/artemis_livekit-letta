import type { ImageBlock } from '@artemis/llm';

export type ImageMediaType = ImageBlock['mediaType'];

/** The image types models read, recognized by their content (filenames and declared types do not count). */
export function imageType(bytes: Uint8Array): ImageMediaType | null {
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('latin1');
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
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

/** A short human label for a binary file, from its signature. */
export function describeBinary(bytes: Uint8Array): string {
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('latin1');
  if (ascii(0, 5) === '%PDF-') return 'PDF document';
  if (ascii(0, 4) === 'PK\x03\x04') return 'zip archive (xlsx, docx, pptx, ...)';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'WAV audio';
  if (ascii(0, 4) === 'OggS') return 'Ogg audio';
  if (ascii(4, 8) === 'ftyp') return 'MPEG-4 media';
  return 'binary data';
}
