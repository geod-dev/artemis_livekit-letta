import { isRecord } from '@artemis/core';

/**
 * Re-exported for the agent-server files that still import it from here; new code imports
 * `isRecord` from `@artemis/core` directly.
 */
export { isRecord };

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
