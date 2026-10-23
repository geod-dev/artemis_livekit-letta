/**
 * Content sniffing: a file's type is read from its bytes, never from its name or
 * a submitted MIME type. Pure functions, so any workspace consumer can use them.
 */

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The image types models read, recognized by their content. */
export function imageType(bytes: Uint8Array): ImageType | null {
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString("latin1");
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Sniff a file's bytes; filenames and submitted MIME types do not determine it. */
export function inspectedMimeType(bytes: Uint8Array): string {
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString("latin1");
  const image = imageType(bytes);
  if (image) return image;
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (
    ascii(0, 3) === "ID3" ||
    (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  )
    return "audio/mpeg";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    return /^(M4A |M4B |M4P )$/.test(brand) ? "audio/mp4" : "video/mp4";
  }
  if (ascii(0, 4) === "PK\x03\x04") return "application/zip";
  if (isUtf8Text(bytes)) {
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return "application/json";
    } catch {
      return "text/plain; charset=utf-8";
    }
  }
  return "application/octet-stream";
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.some((b) => b === 0)) return false;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
      return false;
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
