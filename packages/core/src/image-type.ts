/** The inline image types models read. One definition shared by llm, mcp and workspace. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

export function isImageMediaType(value: unknown): value is ImageMediaType {
  return typeof value === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}
