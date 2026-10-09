import type { ReactNode } from 'react';
import {
  type GenerativeUIAction,
  type GenerativeUILibrary,
  JSONGenerativeUI,
  defaultGenerativeUILibrary,
} from '@assistant-ui/react-generative-ui';

/**
 * Generative UI: the assistant calls the `present` tool with a JSON tree of
 * components (`{ $type, ...props, children }`) and the chat renders it. The
 * backend registers the tool with Letta from `backend/src/assistant/present-tool.json`,
 * generated from this library by `pnpm generate:present-tool`; a test fails
 * when the two differ.
 */
export const PRESENT_TOOL = 'present';

/** The action through which a rendered control sends the user's answer as a chat message. */
export const REPLY_ACTION = 'reply';

const markdown = defaultGenerativeUILibrary.Markdown!;

/**
 * The components `present` can use: assistant-ui's default vocabulary, with
 * `Markdown` drawn by the app (the default shows the markdown source as text).
 */
export function presentLibrary(
  renderMarkdown: (props: { value?: string; children?: ReactNode }) => ReactNode
): GenerativeUILibrary {
  return {
    ...defaultGenerativeUILibrary,
    Markdown: {
      properties: markdown.properties,
      streamProperties: markdown.streamProperties,
      description: 'A markdown string, rendered with GitHub-flavored markdown.',
      render: renderMarkdown,
    },
  };
}

/**
 * The `present` tool as the model sees it. Props that several components
 * declare (`label`, `variant`, …) share one entry in its flat schema: the
 * package warns about each outside production, by design.
 */
export function presentToolSchema(library: GenerativeUILibrary) {
  const { description, parameters } = new JSONGenerativeUI({ library }).present();
  return { name: PRESENT_TOOL, description, parameters };
}

/**
 * The tree as the chat renders it. Models sometimes send `children` as a JSON
 * string, since the schema also accepts a string (for text): a string that
 * encodes components is read as those components.
 */
export function presentTree(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(presentTree);
  if (node === null || typeof node !== 'object' || !('children' in node)) return node;
  const { children, ...props } = node as Record<string, unknown>;
  return { ...props, children: presentTree(decodeChildren(children)) };
}

function decodeChildren(children: unknown): unknown {
  if (typeof children !== 'string' || !/^\s*[[{]/.test(children)) return children;
  try {
    const parsed: unknown = JSON.parse(children);
    const encodesNodes = Array.isArray(parsed) ? parsed.some(isNode) : isNode(parsed);
    return encodesNodes ? parsed : children;
  } catch {
    return children;
  }
}

const isNode = (value: unknown) => value !== null && typeof value === 'object' && '$type' in value;

/**
 * The chat message a `reply` action sends: its `text`, then the value of the
 * control that fired it (`$input`), one `name: value` line per field of a form.
 */
export function replyMessage(action: GenerativeUIAction): string {
  const lines = typeof action.text === 'string' && action.text.trim() ? [action.text.trim()] : [];
  const input = action.$input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    for (const [name, value] of Object.entries(input)) {
      const shown = formatValue(value);
      if (shown) lines.push(`${name}: ${shown}`);
    }
  } else {
    const shown = formatValue(input);
    if (shown) lines.push(shown);
  }
  return lines.join('\n');
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}
