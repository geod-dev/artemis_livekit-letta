import {
  type GenerativeUIAction,
  defaultGenerativeUILibrary,
} from '@assistant-ui/react-generative-ui';
import {
  type PresentValidation,
  validatePresentTree,
} from '@artemis/contracts/present-validation';

/**
 * Generative UI rendering: the assistant calls the `present` tool with a JSON
 * tree of components (`{ componentType, ...props, children }`) and the chat
 * renders it. The library and tool schema live in `@artemis/contracts`.
 */

/** The action through which a rendered control sends the user's answer as a chat message. */
export const REPLY_ACTION = 'reply';

/** Validate and decode a completed `present` call before handing it to React. */
export function validatePresent(node: unknown): PresentValidation {
  return validatePresentTree(node, (type, props) => {
    const component = defaultGenerativeUILibrary[type];
    if (!component) return false;
    const parsed = component.properties.safeParse(props);
    return (
      parsed.success &&
      Object.keys(parsed.data).length === Object.keys(props).length &&
      Object.keys(props).every((key) => Object.hasOwn(parsed.data, key))
    );
  });
}

/**
 * The tree as the chat renders it. Models sometimes send `children` as a JSON
 * string, since the schema also accepts a string (for text): a string that
 * encodes components is read as those components.
 */
export function presentTree(node: unknown): unknown {
  const result = validatePresent(node);
  return result.ok ? result.tree : undefined;
}

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
