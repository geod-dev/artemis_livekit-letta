// Image sniffing lives in @artemis/workspace (media-type.ts); re-exported here for the workspace tools.
export { imageType } from '@artemis/workspace';

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
