/**
 * Sources the assistant cites: markdown links alone in parentheses, separated
 * by commas: `…in March ([The Verge](https://…), [Reuters](https://…)).` The
 * chat shows them as source badges; other links stay links.
 */

const LINK = String.raw`\[[^\]]+\]\(\s*https?:\/\/[^)\s]+\s*\)`;
/** A citation in markdown source. */
const CITATION = new RegExp(String.raw`\(\s*${LINK}(?:\s*,\s*${LINK})*\s*\)`, 'g');

/** The markdown without its citations (they get no link preview card). */
export function withoutCitations(markdown: string): string {
  return markdown.replace(CITATION, '');
}

// The few hast shapes the plugin reads; hast's own types are not a dependency.
type HastText = { type: 'text'; value: string };
type HastElement = {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

const OPEN = /\(\s*$/;
const CLOSE = /^\s*\)/;
const SEPARATOR = /^\s*,\s*$/;

const isText = (node: HastNode | undefined): node is HastText => node?.type === 'text';
const isWebLink = (node: HastNode | undefined): node is HastElement =>
  node?.type === 'element' &&
  (node as HastElement).tagName === 'a' &&
  /^https?:/i.test(String((node as HastElement).properties?.href ?? ''));

/**
 * Rehype plugin: marks each citation link with `data-citation`, and removes the
 * parentheses around them and the commas between them from the text.
 */
export function rehypeCitations() {
  return (tree: HastNode) => markCitations(tree);
}

function markCitations(node: HastNode): void {
  const children = 'children' in node ? node.children : undefined;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const end = citationEnd(children, i);
    if (end === null) {
      markCitations(children[i]);
      continue;
    }
    // children[i - 1] opens the group, children[end + 1] closes it.
    const open = children[i - 1] as HastText;
    const close = children[end + 1] as HastText;
    open.value = open.value.replace(OPEN, '');
    close.value = close.value.replace(CLOSE, '');
    for (let j = i; j <= end; j++) {
      const child = children[j];
      if (isWebLink(child)) child.properties = { ...child.properties, dataCitation: 'true' };
      else (child as HastText).value = ' ';
    }
    i = end + 1;
  }
}

/**
 * When a citation group starts at `start` (links separated by commas, between
 * a text ending with "(" and one starting with ")"), the index of its last link.
 */
function citationEnd(children: HastNode[], start: number): number | null {
  const before = children[start - 1];
  if (!isText(before) || !OPEN.test(before.value)) return null;
  for (let i = start; isWebLink(children[i]); i += 2) {
    const after = children[i + 1];
    if (!isText(after)) return null;
    if (CLOSE.test(after.value)) return i;
    if (!SEPARATOR.test(after.value)) return null;
  }
  return null;
}
