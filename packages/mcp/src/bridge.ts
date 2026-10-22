import { notImplemented } from '@artemis/core';
import type { AnyTool, ToolContext } from '@artemis/tools';
import type { McpCatalog } from './catalog.ts';
import type { McpClient } from './client.ts';

/**
 * The three bridge tools, in this order: `mcp_describe`, `mcp_call`
 * (read-only tools only), `mcp_call_write`. Fixed definitions keep the tool
 * list (and the prompt cache) stable however many MCP tools exist; the model
 * learns names from reminders. Results carry `display: {type:'mcp', artifacts}`.
 * Specs and handlers ported from backend/src/mcp-bridge/tools.ts.
 */
export function createMcpBridgeTools(_catalog: McpCatalog, _client: McpClient): AnyTool<ToolContext>[] {
  return notImplemented('createMcpBridgeTools');
}
