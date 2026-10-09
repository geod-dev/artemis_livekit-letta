/** What every internal tool hands back to the mod: text for the model, flagged or not. */
export interface ToolAnswer {
  text: string;
  isError: boolean;
}

/** One native tool the backend serves. Never throws: a failure is an answer the agent reads. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolAnswer>;

/**
 * How a tool is declared to Letta. `ask` follows the permission mode (the
 * assistant's sessions run unrestricted, so it does not prompt there); `auto`
 * never prompts.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  approval: 'auto' | 'ask';
}

/** Below Letta's 32k tool-return cap, so a continuation hint is never cut off. */
export const MAX_TOOL_TEXT = 30_000;

export function capText(text: string, hint = 'the rest was cut'): string {
  return text.length > MAX_TOOL_TEXT
    ? `${text.slice(0, MAX_TOOL_TEXT)}\n\n[Cut at ${MAX_TOOL_TEXT} characters: ${hint}.]`
    : text;
}
