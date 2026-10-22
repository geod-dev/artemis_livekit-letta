import type { McpServer } from '@artemis/contracts/chat-types';
import type { ListedTool, McpClient } from './client.ts';

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
  /** Servers whose tools were listed by the last refresh. */
  servers: string[];
  tools: number;
  /** Server name -> why it did not list its tools. */
  failures: Record<string, string>;
  refreshedAt: string | null;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_FANOUT = 5;

/** `mcp__<slug(server)>__<tool>`. Server names are validated to `[a-zA-Z0-9_-]`, so the slug is the name. */
export function qualifiedName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^a-zA-Z0-9_-]+/g, '_')}__${tool}`;
}

/** Catalog entries of one server's listed tools (names must be non-empty). */
export function toCatalogTools(server: McpServer, listed: readonly ListedTool[]): CatalogTool[] {
  return listed
    .filter((tool) => typeof tool.name === 'string' && tool.name.length > 0)
    .map((tool) => ({
      qualified: qualifiedName(server.name, tool.name),
      server,
      tool: tool.name,
      description: (tool.description ?? '').trim(),
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {} },
      readOnly: tool.annotations?.readOnlyHint === true,
    }));
}

/**
 * Cached tool list across all configured servers (port of mcp-bridge/catalog.ts).
 * Refreshed when older than the TTL, on demand, and by the owner on every
 * settings change. Unlike the legacy bridge, stdio servers are included: the
 * agent-server spawns them itself. A server that fails keeps no tools and is
 * reported in `status()`; the others still list.
 */
export class McpCatalog {
  private entries: CatalogTool[] = [];
  private failures = new Map<string, string>();
  private listed: string[] = [];
  private fetchedAt: number | null = null;
  private refreshedAt: string | null = null;
  private inflight: Promise<CatalogStatus> | null = null;
  private readonly ttlMs: number;
  private readonly fanout: number;
  private readonly now: () => number;

  constructor(
    readonly client: McpClient,
    readonly servers: () => McpServer[],
    readonly options: { ttlMs?: number; fanout?: number; now?: () => number } = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.fanout = Math.max(1, options.fanout ?? DEFAULT_FANOUT);
    this.now = options.now ?? Date.now;
  }

  /** The cached tools, refreshed first when missing, stale, or `refresh` is set. */
  async tools(options: { refresh?: boolean } = {}): Promise<CatalogTool[]> {
    if (options.refresh || this.isStale()) await this.refresh();
    return this.entries;
  }

  /** Sorted qualified names (input of MCP reminders and subagent prompts). */
  async names(): Promise<string[]> {
    return (await this.tools()).map((tool) => tool.qualified).sort();
  }

  /** Re-list every configured server; concurrent refreshes share one run. */
  refresh(): Promise<CatalogStatus> {
    this.inflight ??= this.list().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** What the last refresh saw, without refreshing. */
  status(): CatalogStatus {
    return {
      servers: [...this.listed],
      tools: this.entries.length,
      failures: Object.fromEntries(this.failures),
      refreshedAt: this.refreshedAt,
    };
  }

  private isStale(): boolean {
    return this.fetchedAt === null || this.now() - this.fetchedAt > this.ttlMs;
  }

  private async list(): Promise<CatalogStatus> {
    const servers = this.servers();
    const lists: CatalogTool[][] = servers.map(() => []);
    const failures = new Map<string, string>();
    let next = 0;
    const worker = async () => {
      while (next < servers.length) {
        const index = next++;
        const server = servers[index];
        if (!server) return;
        try {
          lists[index] = toCatalogTools(server, await this.client.listTools(server));
        } catch (error) {
          failures.set(server.name, error instanceof Error ? error.message : String(error));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.fanout, servers.length) }, worker));
    this.entries = lists.flat();
    this.failures = failures;
    this.listed = servers.map((server) => server.name).filter((name) => !failures.has(name));
    this.fetchedAt = this.now();
    this.refreshedAt = new Date(this.fetchedAt).toISOString();
    return this.status();
  }
}
