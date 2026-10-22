import type { ToolDefinition } from '@artemis/llm';
import type { ToolContext } from './context.ts';
import { errorResult, type ToolResult } from './result.ts';
import { type AnyTool, ToolInputError } from './tool.ts';

/**
 * An ordered, name-unique set of tools. `definitions()` is deterministic
 * (insertion order) so the provider prompt cache stays valid.
 *
 * Conversations freeze their definitions at creation (prompt snapshot); at run
 * time `execute` looks tools up by name, so a call to a tool the frozen list
 * offers but the code no longer has returns an error result.
 */
export class Toolset<C extends ToolContext = ToolContext> {
  private readonly byName = new Map<string, AnyTool<C>>();
  private readonly defs: ToolDefinition[];

  constructor(readonly tools: readonly AnyTool<C>[]) {
    for (const tool of tools) {
      if (this.byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      this.byName.set(tool.name, tool);
    }
    this.defs = tools.map((tool) => tool.definition());
  }

  definitions(): ToolDefinition[] {
    return [...this.defs];
  }

  get(name: string): AnyTool<C> | undefined {
    return this.byName.get(name);
  }

  /** parse -> execute; unknown tool, invalid input and unexpected throws become error results. */
  async execute(name: string, input: unknown, context: C): Promise<ToolResult> {
    const tool = this.byName.get(name);
    if (!tool) return errorResult(`Unknown tool "${name}".`);
    let parsed: unknown;
    try {
      parsed = tool.parse(input);
    } catch (error) {
      if (error instanceof ToolInputError) return errorResult(error.message);
      return errorResult(`${name}: invalid input (${messageOf(error)}).`);
    }
    try {
      return await tool.execute(parsed, context);
    } catch (error) {
      context.logger.error('tool threw', { tool: name, error: messageOf(error) });
      return errorResult(`${name} failed: ${messageOf(error)}`);
    }
  }

  /** A new toolset with `tools` appended (names must stay unique). */
  with(tools: readonly AnyTool<C>[]): Toolset<C> {
    return new Toolset<C>([...this.tools, ...tools]);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
