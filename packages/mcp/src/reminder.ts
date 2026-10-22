import { notImplemented } from '@artemis/core';

/**
 * `<system-reminder>` for the next user turn (port of
 * backend/src/assistant/mcp-context.ts): the full list when `previous` is null,
 * otherwise Added/Removed; undefined when nothing changed.
 */
export function mcpToolsReminder(_current: readonly string[], _previous: readonly string[] | null): string | undefined {
  return notImplemented('mcpToolsReminder');
}

/** Name + one-line description list embedded in subagent system prompts. */
export function mcpToolsSection(_tools: ReadonlyArray<{ qualified: string; description: string; readOnly: boolean }>): string {
  return notImplemented('mcpToolsSection');
}
