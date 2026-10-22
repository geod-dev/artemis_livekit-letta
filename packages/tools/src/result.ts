import type { ToolDisplay, ToolTaskRef } from '@artemis/contracts/chat-types';
import type { ImageBlock, TextBlock } from '@artemis/llm';

/** Model-facing text cap per tool result (a continuation hint is appended when cut). */
export const MAX_TOOL_TEXT = 30_000;

export interface ToolResult {
  /** What the model receives. */
  content: Array<TextBlock | ImageBlock>;
  isError: boolean;
  /** Structured rendering for the UI (never sent to the model). */
  display?: ToolDisplay;
  /** Relation to a background task, when any. */
  task?: ToolTaskRef;
  /** The call outlived the handoff delay and continues as this task. */
  backgrounded?: boolean;
}

export function textResult(text: string, extra: Omit<ToolResult, 'content' | 'isError'> = {}): ToolResult {
  return { content: [{ type: 'text', text }], isError: false, ...extra };
}

export function errorResult(text: string, extra: Omit<ToolResult, 'content' | 'isError'> = {}): ToolResult {
  return { content: [{ type: 'text', text }], isError: true, ...extra };
}

/** Cut `text` at `MAX_TOOL_TEXT` with `[Cut at N characters: <hint>.]`. */
export function capText(text: string, hint = 'the rest was cut'): string {
  return text.length > MAX_TOOL_TEXT
    ? `${text.slice(0, MAX_TOOL_TEXT)}\n\n[Cut at ${MAX_TOOL_TEXT} characters: ${hint}.]`
    : text;
}
