import presentTool from './present-tool.json' with { type: 'json' };

/**
 * Generative UI. The `present` tool's schema is generated from the chat's
 * component library (`pnpm generate:present-tool` in frontend/), which renders
 * the call's arguments as UI. The tool only checks that the chat can draw the
 * tree; nothing runs here.
 */
export const PRESENT_TOOL = presentTool.name;
export const presentDescription = presentTool.description;
export const presentParameters = presentTool.parameters;

const COMPONENTS = new Set<string>(presentTool.parameters.properties.$type.enum);

/** The component names of a `present` tree that the chat does not have, and nodes without one. */
export function unknownComponents(node: unknown): string[] {
  const unknown = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== 'object') return;
    const { $type, children } = value as { $type?: unknown; children?: unknown };
    if (typeof $type !== 'string') unknown.add('(missing $type)');
    else if (!COMPONENTS.has($type)) unknown.add($type);
    visit(decodeChildren(children));
  };
  visit(node);
  return [...unknown];
}

/**
 * Models sometimes send `children` as a JSON string, since the schema also
 * accepts a string (for text). The chat reads a string that encodes
 * components as those components (`presentTree` in the frontend), and so does
 * this check.
 */
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

/** The tool's answer to the model. */
export function presentOutcome(input: unknown): { text: string; isError: boolean } {
  const unknown = unknownComponents(input);
  if (unknown.length > 0) {
    return {
      text: `Not shown: unknown components ${unknown.join(', ')}. Use only: ${[...COMPONENTS].join(', ')}.`,
      isError: true,
    };
  }
  return { text: 'Shown to the user in the chat.', isError: false };
}
