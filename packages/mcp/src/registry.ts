import { notImplemented } from '@artemis/core';
import type { McpServer, McpSettingsResponse } from '@artemis/contracts/chat-types';

/** Persistence port (implemented over `McpSettingsRepository`). */
export interface McpSettingsStore {
  load(): Promise<{ servers: McpServer[]; invalidEntries: unknown[]; revision: string | null }>;
  /** Compare-and-set; throws `ConflictError('revision_conflict')`. */
  save(servers: McpServer[], invalidEntries: unknown[], expectedRevision: string | null): Promise<string>;
}

/**
 * One serialized store merging user-configured servers (Postgres) and
 * connection-managed device servers pushed by the gateway
 * (`PUT /v1/mcp/managed`). Every change refreshes the catalog and notifies
 * listeners (conversations get an MCP reminder diff on their next turn).
 */
export class McpServerRegistry {
  constructor(
    readonly store: McpSettingsStore,
    readonly onChange: (servers: McpServer[]) => Promise<void>
  ) {}

  /** Manual + managed servers. */
  servers(): McpServer[] {
    return notImplemented('McpServerRegistry.servers');
  }

  load(): Promise<void> {
    return notImplemented('McpServerRegistry.load');
  }

  /** `GET /v1/mcp` body. */
  settings(): Promise<McpSettingsResponse> {
    return notImplemented('McpServerRegistry.settings');
  }

  /** `PUT /v1/mcp` with If-Match. */
  save(_servers: unknown, _ifMatch: string | null): Promise<McpSettingsResponse> {
    return notImplemented('McpServerRegistry.save');
  }

  setManaged(_servers: McpServer[]): Promise<void> {
    return notImplemented('McpServerRegistry.setManaged');
  }
}
