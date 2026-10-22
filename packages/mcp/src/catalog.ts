import { notImplemented } from '@artemis/core';
import type { McpServer } from '@artemis/contracts/chat-types';
import type { McpClient } from './client.ts';

export interface CatalogTool {
  /** `mcp__<server>__<tool>`. */
  qualified: string;
  server: McpServer;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP `readOnlyHint`; unmarked counts as a write. */
  readOnly: boolean;
}

export interface CatalogStatus {
  servers: string[];
  tools: number;
  failures: Record<string, string>;
  refreshedAt: string | null;
}

/** `mcp__<slug(server)>__<tool>`. */
export function qualifiedName(_server: string, _tool: string): string {
  return notImplemented('qualifiedName');
}

/**
 * Cached tool list across all servers (port of mcp-bridge/catalog.ts): TTL
 * 10 min, fan-out 5, refreshed on every settings change. Unlike Letta, stdio
 * servers are included (spawned by the agent-server).
 */
export class McpCatalog {
  constructor(
    readonly client: McpClient,
    readonly servers: () => McpServer[],
    readonly options: { ttlMs?: number; fanout?: number } = {}
  ) {}

  tools(_options?: { refresh?: boolean }): Promise<CatalogTool[]> {
    return notImplemented('McpCatalog.tools');
  }

  /** Sorted qualified names (input of MCP reminders and subagent prompts). */
  names(): Promise<string[]> {
    return notImplemented('McpCatalog.names');
  }

  refresh(): Promise<CatalogStatus> {
    return notImplemented('McpCatalog.refresh');
  }

  status(): CatalogStatus {
    return notImplemented('McpCatalog.status');
  }
}
