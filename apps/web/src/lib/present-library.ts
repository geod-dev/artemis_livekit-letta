import { TOOL_NAMES } from '@artemis/contracts/tool-names';
import {
  type GenerativeUIComponent,
  type GenerativeUILibrary,
  JSONGenerativeUI,
  defaultGenerativeUILibrary,
} from '@assistant-ui/react-generative-ui';

/**
 * The generative UI library the assistant's `present` tool is built from. The
 * agent-server registers the tool from `packages/contracts/generated/present-tool.json`,
 * generated from this module by `pnpm generate:present-tool` (scripts/generate-present-tool.ts);
 * the component names it must implement are declared in `@artemis/contracts/present-components`.
 * `pnpm check:schema` fails when the generated files differ.
 */
export const PRESENT_TOOL = TOOL_NAMES.present;

type ReactNode = ReturnType<GenerativeUIComponent['render']>;

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

/** The warning the package prints for each prop that several components declare. */
const SHARED_PROP_WARNING = '[@assistant-ui/react-generative-ui] Prop ';

/**
 * Runs `run` with the package's shared-prop warnings dropped when `warnings` is false.
 * The package prints them outside production only, so this scopes the console and
 * leaves the process environment alone.
 */
function withSharedPropWarnings<T>(warnings: boolean, run: () => T): T {
  if (warnings) return run();
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith(SHARED_PROP_WARNING)) return;
    warn(...args);
  };
  try {
    return run();
  } finally {
    console.warn = warn;
  }
}

/**
 * The `present` tool as the model sees it. Props that several components
 * declare (`label`, `variant`, …) share one entry in its flat schema: the
 * package warns about each outside production, by design. Pass `warnings: false`
 * where those warnings are noise (the generator and the tests).
 */
export function presentToolSchema(library: GenerativeUILibrary, { warnings = true } = {}) {
  const { description, parameters } = withSharedPropWarnings(warnings, () =>
    new JSONGenerativeUI({ library }).present()
  );
  // Claude requires alphanumeric property names. Translate the library's
  // reserved names in schemas, required lists, and model-facing descriptions.
  return JSON.parse(
    JSON.stringify({ name: PRESENT_TOOL, description, parameters })
      .replaceAll('$type', 'componentType')
      .replaceAll('$key', 'componentKey')
      .replaceAll('$action', 'action')
  ) as { name: string; description: string; parameters: Record<string, unknown> };
}
