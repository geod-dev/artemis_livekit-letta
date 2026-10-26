function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    nbsp: ' ',
  };
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
    (original, entity: string) => {
      if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? original;
      const point =
        entity.charAt(1).toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : original;
    }
  );
}

export type LinkMetadata = { title?: string; description?: string };

/** Metadata sits near the top of a page; nothing past this is read. */
const MAX_HEAD_CHARS = 64 * 1024;
/** A meta tag longer than this is not read. Bounding it keeps an unclosed quote cheap. */
const MAX_TAG_CHARS = 2048;

/** Social titles are written for previews; fall back to the document title. */
export function linkMetadata(html: string): LinkMetadata {
  const head = documentHead(html);
  const descriptions = new Map<string, string>();
  for (const tag of metaTags(head)) {
    const attrs = new Map<string, string>();
    for (const [, key = '', quoted, single, bare] of tag.matchAll(
      /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
    )) {
      attrs.set(key.toLowerCase(), quoted ?? single ?? bare ?? '');
    }
    const name = (attrs.get('name') ?? attrs.get('property'))?.toLowerCase();
    const content = attrs.get('content');
    if (name && content)
      descriptions.set(name, decodeEntities(content).replace(/\s+/g, ' ').trim());
  }
  const description =
    descriptions.get('description') ||
    descriptions.get('og:description') ||
    descriptions.get('twitter:description');
  const documentTitleText = documentTitle(head);
  const title =
    descriptions.get('og:title') ||
    descriptions.get('twitter:title') ||
    descriptions.get('title') ||
    (documentTitleText && decodeEntities(documentTitleText).replace(/\s+/g, ' ').trim()) ||
    undefined;
  const words = description?.split(' ');
  return {
    title,
    description: words && words.length > 24 ? `${words.slice(0, 24).join(' ')}…` : description,
  };
}

/** The document head, without comments and scripts, capped at MAX_HEAD_CHARS. */
function documentHead(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  const head = end === -1 ? html : html.slice(0, end);
  return withoutScripts(withoutComments(head.slice(0, MAX_HEAD_CHARS)));
}

/**
 * Removes every `start`...`end` block, case-insensitively, in one forward pass. `closeAt` returns
 * the index just past the block's closing marker, or -1 when the block never closes; an unclosed
 * block removes the rest of the text, as a browser reads it.
 */
function withoutBlocks(
  text: string,
  start: string,
  closeAt: (lower: string, from: number) => number
): string {
  const lower = text.toLowerCase();
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = lower.indexOf(start, cursor);
    if (open === -1) return out + text.slice(cursor);
    const after = closeAt(lower, open + start.length);
    if (after === -1) return out + text.slice(cursor, open);
    out += text.slice(cursor, open);
    cursor = after;
  }
}

function withoutComments(text: string): string {
  return withoutBlocks(text, '<!--', (lower, from) => {
    const at = lower.indexOf('-->', from);
    return at === -1 ? -1 : at + 3;
  });
}

function withoutScripts(text: string): string {
  return withoutBlocks(text, '<script', (lower, from) => {
    const close = lower.indexOf('</script', from);
    if (close === -1) return -1;
    const gt = lower.indexOf('>', close);
    return gt === -1 ? -1 : gt + 1;
  });
}

/** The `<meta ...>` tags in `head`. A tag whose quotes never close is skipped, not scanned to the end. */
function metaTags(head: string): string[] {
  const lower = head.toLowerCase();
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = lower.indexOf('<meta', from);
    if (start === -1) return tags;
    const next = lower.charAt(start + 5);
    const boundary = next === '' || /[\s/>]/.test(next);
    const end = boundary ? tagEnd(head, start) : -1;
    if (end === -1) {
      from = start + 5;
      continue;
    }
    tags.push(head.slice(start, end + 1));
    from = end + 1;
  }
}

/** Index of the `>` that closes the tag opened at `from`, outside quoted values; -1 if none in range. */
function tagEnd(text: string, from: number): number {
  const limit = Math.min(text.length, from + MAX_TAG_CHARS);
  let quote = '';
  for (let i = from; i < limit; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/** Text of the first <title> in `head`, found by forward scans only. */
function documentTitle(head: string): string | undefined {
  const lower = head.toLowerCase();
  const open = lower.indexOf('<title');
  if (open === -1) return undefined;
  const gt = lower.indexOf('>', open);
  if (gt === -1) return undefined;
  const close = lower.indexOf('</title', gt);
  if (close === -1) return undefined;
  return head.slice(gt + 1, close);
}
