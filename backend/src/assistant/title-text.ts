/** Text helpers for conversation titles (no server dependencies, unit-tested). */

const MAX_TITLE_LENGTH = 60;

/** The first message itself, shortened: used when the title model fails. */
export function fallbackTitle(firstMessage: string): string {
  return firstMessage.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH) || 'New chat';
}

/**
 * Turn a model reply into a clean title: drop reasoning blocks, labels, quotes,
 * markdown and trailing punctuation, keep one short line. Throws when nothing
 * usable is left.
 */
export function cleanTitle(reply: string): string {
  const line =
    reply
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  const title = line
    .replace(/[*_#`]/g, '')
    .replace(/^\s*(title|titre|título|titel)\s*:\s*/i, '')
    .replace(/^["'“”‘’«»\s]+|["'“”‘’«»\s]+$/g, '')
    .replace(/[.!?。！？:;,]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) throw new Error(`No title in model reply: ${JSON.stringify(reply.slice(0, 200))}`);
  return title.length > MAX_TITLE_LENGTH
    ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : title;
}
