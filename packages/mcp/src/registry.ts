import { ConflictError } from '@artemis/core';
import type { McpServer, McpSettingsResponse } from '@artemis/contracts/chat-types';
import type { CatalogStatus } from './catalog.ts';
import { InvalidMcpServersError, describeInvalidEntry, mcpRevision, validateMcpServers } from './settings.ts';

/** Persistence port (implemented over `McpSettingsRepository`). */
export interface McpSettingsStore {
  load(): Promise<{ servers: McpServer[]; invalidEntries: unknown[]; revision: string | null }>;
  /**
   * Compare-and-set on `expectedRevision` (null = nothing stored yet); returns
   * the new revision (`mcpRevision(servers)`). Throws `ConflictError('revision_conflict')`.
   */
  save(servers: McpServer[], invalidEntries: unknown[], expectedRevision: string | null): Promise<string>;
}

type McpSync = NonNullable<McpSettingsResponse['sync']>;

const NO_BRIDGE: CatalogStatus = { servers: [], tools: 0, failures: {}, refreshedAt: null };

/**
 * One serialized store merging user-configured servers (persisted) and
 * connection-managed device servers (memory, pushed by the gateway through
 * `setManaged`). Every change calls `onChange` with the full server list, which
 * the owner uses to refresh the catalog; conversations see the change as an MCP
 * reminder diff on their next turn.
 *
 * `bridgeStatus` (usually `catalog.status`) feeds the `bridge` part of
 * `settings()`; without it the bridge reads as empty.
 */
export class McpServerRegistry {
  private manual: McpServer[] = [];
  private invalidEntries: unknown[] = [];
  private managed: McpServer[] = [];
  private lastSync: McpSync | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly store: McpSettingsStore,
    readonly onChange: (servers: McpServer[]) => Promise<void>,
    readonly bridgeStatus: () => CatalogStatus = () => NO_BRIDGE
  ) {}

  /** Manual + managed servers (as loaded or last saved; call `load` first). */
  servers(): McpServer[] {
    return [...this.manual, ...this.managed];
  }

  /** Read the stored list into memory. Call once at startup, before `servers()`. */
  load(): Promise<void> {
    return this.serial(async () => {
      const stored = await this.store.load();
      this.manual = stored.servers;
      this.invalidEntries = stored.invalidEntries;
    });
  }

  /** `GET /v1/mcp` body. */
  async settings(): Promise<McpSettingsResponse> {
    const bridge = this.bridgeStatus();
    return {
      revision: mcpRevision(this.manual),
      servers: this.servers(),
      diagnostics: this.invalidEntries.map((value, index) => ({
        index,
        diagnostic: describeInvalidEntry(value),
        value,
      })),
      ...(this.lastSync ? { sync: this.lastSync } : {}),
      bridge: { servers: bridge.servers, tools: bridge.tools, failures: bridge.failures },
    };
  }

  /**
   * `PUT /v1/mcp`: replace the manual list. `ifMatch` is the revision the editor
   * loaded (`If-Match`); null saves unconditionally. Connected device names are
   * reserved.
   */
  save(servers: unknown, ifMatch: string | null): Promise<McpSettingsResponse> {
    return this.serial(async () => {
      const next = validateMcpServers(servers);
      this.assertNoDeviceClash(next);
      const stored = await this.store.load();
      if (ifMatch !== null && ifMatch !== mcpRevision(stored.servers)) {
        throw new ConflictError(
          'revision_conflict',
          'MCP settings changed since they were loaded. Reload and try again.'
        );
      }
      const revision = await this.store.save(next, stored.invalidEntries, stored.revision);
      this.manual = next;
      this.invalidEntries = stored.invalidEntries;
      const catalog = await this.notify();
      this.lastSync = { saved: true, catalog, retryableRevision: revision };
      return this.settings();
    });
  }

  /** Replace the connection-managed servers (the gateway's full list of connected devices). */
  setManaged(servers: McpServer[]): Promise<void> {
    return this.serial(async () => {
      for (const server of servers) {
        if (server.managed?.type !== 'device') {
          throw new InvalidMcpServersError(`Server "${server.name}" is not connection-managed`);
        }
      }
      validateNames(servers);
      this.assertNoDeviceClash(servers);
      this.managed = servers;
      await this.notify();
    });
  }

  private assertNoDeviceClash(servers: readonly McpServer[]): void {
    const devices = new Set(this.managed.map((server) => server.name));
    const clash = servers.find((server) => devices.has(server.name));
    if (clash) {
      throw new InvalidMcpServersError(
        `The name ${clash.name} is used by a connected device. Choose another server name.`
      );
    }
  }

  /** Run `onChange`; a failure is reported as a `failed` catalog sync, never thrown. */
  private async notify(): Promise<McpSync['catalog']> {
    try {
      await this.onChange(this.servers());
      return 'synced';
    } catch {
      return 'failed';
    }
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(() => run());
    this.chain = result.catch(() => undefined);
    return result;
  }
}

function validateNames(servers: readonly McpServer[]): void {
  const names = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) throw new InvalidMcpServersError(`Duplicate server name: ${server.name}`);
    names.add(server.name);
  }
}
