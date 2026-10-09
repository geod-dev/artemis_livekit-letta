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
        entity[1].toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : original;
    }
  );
}

export type LinkMetadata = { title?: string; description?: string };

/** Social titles are written for previews; fall back to the document title. */
export function linkMetadata(html: string): LinkMetadata {
  const descriptions = new Map<string, string>();
  const head = html
    .split(/<\/head\s*>/i)[0]
    .replace(/<!--[^]*?-->|<script\b[^]*?<\/script\s*>/gi, '');
  for (const tag of head.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = new Map<string, string>();
    for (const attr of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs.set(attr[1].toLowerCase(), attr[2] ?? attr[3] ?? attr[4]);
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
  const documentTitle = head.match(/<title\b[^>]*>([^]*?)<\/title\s*>/i)?.[1];
  const title =
    descriptions.get('og:title') ||
    descriptions.get('twitter:title') ||
    descriptions.get('title') ||
    (documentTitle && decodeEntities(documentTitle).replace(/\s+/g, ' ').trim()) ||
    undefined;
  const words = description?.split(' ');
  return {
    title,
    description: words && words.length > 24 ? `${words.slice(0, 24).join(' ')}…` : description,
  };
}

export function linkDescription(html: string): string | undefined {
  return linkMetadata(html).description;
}
