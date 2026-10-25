import type { ToolDisplay, ToolTaskRef } from '@artemis/contracts/chat-types';
import { TOOL_NAMES } from '@artemis/contracts/tool-names';

/**
 * What a tool call is, as the thread's presentations read it. Plain functions with no
 * components, so the libraries under lib/ can use them (the components render them).
 */

/** What the server sent with a call: its display, and the background task it started or moved. */
export type ToolCallUi = { display?: ToolDisplay; task?: ToolTaskRef };

/** A tool call, as presentations match and describe it. */
export type ToolCall = {
  toolName: string;
  /** The raw arguments, possibly still streaming. */
  argsText: string | undefined;
  args: Record<string, unknown>;
  ui: ToolCallUi;
};

export const nonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** The arguments of a call as an object; {} while they are not (yet) a JSON object. */
function parseToolArgs(argsText: string | undefined): Record<string, unknown> {
  if (!argsText) return {};
  try {
    const args: unknown = JSON.parse(argsText);
    return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  } catch {
    // Arguments may still be streaming, or not JSON at all.
    return {};
  }
}

export function toolCall(
  toolName: string,
  argsText: string | undefined,
  ui: ToolCallUi = {}
): ToolCall {
  return { toolName, argsText, args: parseToolArgs(argsText), ui };
}

/** The bridge tools that run an MCP tool: `{ tool, arguments }`. */
export const BRIDGE_CALLS: readonly string[] = [TOOL_NAMES.mcpCall, TOOL_NAMES.mcpCallWrite];

/**
 * The MCP tool a bridge call runs (`mcp__<server>__<tool>`, or a bare name) and
 * the JSON of its arguments; undefined for other calls.
 */
export function mcpToolCall(
  call: ToolCall
): { tool: string; argsText: string | undefined } | undefined {
  if (!BRIDGE_CALLS.includes(call.toolName)) return undefined;
  const tool = nonEmptyString(call.args.tool)?.trim();
  const args = call.args.arguments;
  if (!tool) return undefined;
  return { tool, argsText: typeof args === 'string' ? args : JSON.stringify(args ?? {}) };
}

/**
 * Matches calls of an MCP tool by its own name, whatever the server is called
 * in Settings: `web_search_exa` matches `mcp__<server>__web_search_exa`.
 */
export const mcpTool =
  (...names: (string | RegExp)[]) =>
  (call: ToolCall) => {
    const tool = mcpToolCall(call)?.tool;
    return (
      tool !== undefined &&
      names.some((name) =>
        typeof name === 'string'
          ? tool === name || tool.endsWith(`__${name}`)
          : name.test(tool.replace(/^mcp__.+?__/, ''))
      )
    );
  };

export const isWebSearch = mcpTool('web_search_exa');

/** The query of a web search (empty until it can be read), or undefined for other calls. */
export function webSearchQuery(call: ToolCall): string | undefined {
  if (!isWebSearch(call)) return undefined;
  try {
    const args: unknown = JSON.parse(mcpToolCall(call)?.argsText ?? '');
    const query = (args as { query?: unknown } | null)?.query;
    return typeof query === 'string' ? query : '';
  } catch {
    return '';
  }
}
