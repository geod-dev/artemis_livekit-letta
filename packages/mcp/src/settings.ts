import { notImplemented } from '@artemis/core';
import type { McpServer } from '@artemis/contracts/chat-types';

export type { McpServer };

export class InvalidMcpServersError extends Error {
  constructor(
    message: string,
    readonly entries: Array<{ index: number; diagnostic: string; value: unknown }>
  ) {
    super(message);
    this.name = 'InvalidMcpServersError';
  }
}

/**
 * Validate a user-edited server list (port of backend/src/mcp/settings.ts
 * `validateMcpServers`, without the Letta file format): unique names
 * `[a-zA-Z0-9_-]`, transport stdio/http/sse with the matching fields, env and
 * header checks, at most 100 servers, `managed` entries rejected.
 */
export function validateMcpServers(_value: unknown): McpServer[] {
  return notImplemented('validateMcpServers');
}

/** sha256 of the canonical JSON of the list: the `revision` / ETag. */
export function mcpRevision(_servers: readonly McpServer[]): string {
  return notImplemented('mcpRevision');
}
