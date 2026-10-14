import { type McpIo, loadMcpServers, saveMcpServers } from './service';
import {
  InvalidMcpServersError,
  MCP_SETTINGS_PATH,
  readMcpSettings,
  type McpServer,
} from './settings';
import { createHash } from 'node:crypto';

export class McpRevisionConflictError extends Error {}

export interface McpSaveResult {
  revision: string;
  syncError?: string;
  sync?: {
    skill: 'synced' | 'failed' | 'pending';
    catalog: 'synced' | 'failed' | 'pending';
    prompt: 'synced' | 'failed' | 'pending';
    mod: 'synced' | 'failed' | 'pending';
  };
}

/** One serialised store for manually configured and connection-managed servers. */
export class McpRegistry {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly io: McpIo,
    private readonly devices: () => McpServer[],
    private readonly changed: () => Promise<void | {
      catalog: 'synced' | 'failed' | 'pending';
      prompt: 'synced' | 'failed' | 'pending';
      mod: 'synced' | 'failed' | 'pending';
    }>
  ) {}

  list(): Promise<McpServer[]> {
    return loadMcpServers(this.io);
  }

  async snapshot() {
    const raw = await this.io.read(MCP_SETTINGS_PATH);
    const parsed = raw === null ? { servers: [], invalidEntries: [] } : readMcpSettings(raw);
    return {
      ...parsed,
      revision: createHash('sha256')
        .update(raw ?? '')
        .digest('hex'),
    };
  }

  private update(manual?: McpServer[], expectedRevision?: string): Promise<McpSaveResult> {
    const run = this.chain.then(async () => {
      const current = await this.snapshot();
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        throw new McpRevisionConflictError(
          'MCP settings changed since they were loaded. Reload and try again.'
        );
      }
      const previous = await this.list();
      const configured = manual ?? previous.filter((server) => !server.managed);
      const devices = this.devices();
      for (const device of devices)
        if (configured.some((server) => server.name === device.name)) {
          throw new InvalidMcpServersError(
            `The name ${device.name} is used by a connected device. Choose another server name.`
          );
        }
      const next = [...configured, ...devices];
      // Also updates the shared skill when reconciling after a deploy.
      const skillSync = await saveMcpServers(this.io, next);
      const saved = await this.snapshot();
      let syncError: string | undefined;
      let sync: McpSaveResult['sync'];
      try {
        sync = {
          skill: skillSync.skill,
          ...((await this.changed()) ?? {
            catalog: 'synced',
            prompt: 'synced',
            mod: 'synced',
          }),
        };
        if (skillSync.error) syncError = skillSync.error;
      } catch (error) {
        syncError = error instanceof Error ? error.message : String(error);
        sync = {
          skill: skillSync.skill,
          catalog: 'failed',
          prompt: 'pending',
          mod: 'pending',
        };
      }
      return {
        revision: saved.revision,
        ...(syncError ? { syncError } : {}),
        ...(sync ? { sync } : {}),
      };
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /** Remove stale device entries after a restart and publish current connections. */
  reconcile(): Promise<void> {
    return this.update().then(() => undefined);
  }

  /** The settings API only owns manually configured entries. */
  async saveManual(servers: McpServer[], expectedRevision?: string): Promise<McpSaveResult> {
    if (servers.some((server) => server.managed))
      throw new InvalidMcpServersError('Connected devices are managed by their connections');
    return this.update(servers, expectedRevision);
  }
}
