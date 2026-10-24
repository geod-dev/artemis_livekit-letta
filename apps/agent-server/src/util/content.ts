/** True for a plain object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text of the `text` blocks of a content array, joined by newlines; other block kinds are skipped. */
export function contentText(content: readonly unknown[]): string {
  return content
    .flatMap((block) => {
      if (!isRecord(block)) return [];
      const { type, text } = block;
      return type === 'text' && typeof text === 'string' ? [text] : [];
    })
    .join('\n');
}
