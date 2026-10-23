import {
  type GenerativeUIComponent,
  type GenerativeUILibrary,
  JSONGenerativeUI,
  defaultGenerativeUILibrary,
} from '@assistant-ui/react-generative-ui';

/**
 * The generative UI library the assistant's `present` tool is built from. The
 * agent-server registers the tool from `generated/present-tool.json`, generated
 * from this module by `pnpm generate:present-tool`; the frontend's test fails
 * when the two differ.
 */
export const PRESENT_TOOL = 'present';

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

/**
 * The `present` tool as the model sees it. Props that several components
 * declare (`label`, `variant`, …) share one entry in its flat schema: the
 * package warns about each outside production, by design.
 */
export function presentToolSchema(library: GenerativeUILibrary) {
  const { description, parameters } = new JSONGenerativeUI({ library }).present();
  // Claude requires alphanumeric property names. Translate the library's
  // reserved names in schemas, required lists, and model-facing descriptions.
  return JSON.parse(
    JSON.stringify({ name: PRESENT_TOOL, description, parameters })
      .replaceAll('$type', 'componentType')
      .replaceAll('$key', 'componentKey')
      .replaceAll('$action', 'action')
  ) as { name: string; description: string; parameters: Record<string, unknown> };
}
