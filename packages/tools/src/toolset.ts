import { notImplemented } from '@artemis/core';
import type { ToolDefinition } from '@artemis/llm';
import type { ToolContext } from './context.ts';
import type { ToolResult } from './result.ts';
import type { AnyTool } from './tool.ts';

/**
 * An ordered, name-unique set of tools. `definitions()` is deterministic
 * (insertion order) so the provider prompt cache stays valid.
 *
 * Conversations freeze their definitions at creation (prompt snapshot); at run
 * time `execute` looks tools up by name, so a call to a tool the frozen list
 * offers but the code no longer has returns an error result.
 */
export class Toolset<C extends ToolContext = ToolContext> {
  constructor(readonly tools: readonly AnyTool<C>[]) {}

  definitions(): ToolDefinition[] {
    return notImplemented('Toolset.definitions');
  }

  get(_name: string): AnyTool<C> | undefined {
    return notImplemented('Toolset.get');
  }

  /** parse -> execute; unknown tool, invalid input and unexpected throws become error results. */
  execute(_name: string, _input: unknown, _context: C): Promise<ToolResult> {
    return notImplemented('Toolset.execute');
  }

  /** A new toolset with `tools` appended (names must stay unique). */
  with(_tools: readonly AnyTool<C>[]): Toolset<C> {
    return notImplemented('Toolset.with');
  }
}
