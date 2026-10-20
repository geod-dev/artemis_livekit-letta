/**
 * Every tool of every bridgeable server in the shared MCP list, as the native
 * `mcp_*` tools see them.
 *
 * Listed from the servers themselves (`tools/list`) and cached: refreshed on
 * connect to the Letta server, on every save of the shared list, and when
 * older than the TTL.
 */
import type { McpServer } from '../mcp/settings';
import { type ListedTool, type McpClientPort, isBridgeable } from './client';

export interface CatalogTool {
  /** `mcp__<server>__<tool>`: Letta's naming for MCP tools. */
  qualified: string;
  server: McpServer;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The server marks it read-only (MCP `readOnlyHint`). Unmarked counts as a write. */
  readOnly: boolean;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const SERVER_FANOUT = 5;

function serverSlug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

export function qualifiedName(server: string, tool: string): string {
  return `mcp__${serverSlug(server)}__${tool}`;
}

export function toCatalogTools(server: McpServer, listed: readonly ListedTool[]): CatalogTool[] {
  return listed
    .filter((tool) => typeof tool.name === 'string' && tool.name)
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

export class McpCatalog {
  private tools: CatalogTool[] = [];
  private fetchedAt = 0;
  private failures = new Map<string, string>();
  private inflight: Promise<CatalogTool[]> | null = null;

  constructor(
    private readonly deps: {
      servers: () => Promise<McpServer[]>;
      client: McpClientPort;
      log?: (message: string) => void;
      now?: () => number;
      ttlMs?: number;
    }
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Re-list every bridgeable server. A server that fails keeps no tools and is reported. */
  refresh(): Promise<CatalogTool[]> {
    this.inflight ??= (async () => {
      try {
        const servers = (await this.deps.servers()).filter(isBridgeable);
        if (servers.length > 100)
          throw new Error('MCP bridge is limited to 100 configured servers');
        const failures = new Map<string, string>();
        const lists: CatalogTool[][] = Array.from({ length: servers.length }, () => []);
        let nextIndex = 0;
        const workers = Array.from(
          { length: Math.min(SERVER_FANOUT, servers.length) },
          async () => {
            while (true) {
              const index = nextIndex++;
              const server = servers[index];
              if (!server) return;
              try {
                lists[index] = toCatalogTools(server, await this.deps.client.listTools(server));
              } catch (error) {
                failures.set(server.name, error instanceof Error ? error.message : String(error));
              }
            }
          }
        );
        await Promise.all(workers);
        this.tools = lists.flat();
        this.failures = failures;
        this.fetchedAt = this.now();
        for (const [name, reason] of failures) {
          this.deps.log?.(`MCP bridge: ${name} did not list tools (${reason})`);
        }
        return this.tools;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** The cached tools, refreshed first when older than the TTL. */
  async current(): Promise<CatalogTool[]> {
    if (this.fetchedAt === 0 || this.now() - this.fetchedAt > (this.deps.ttlMs ?? DEFAULT_TTL_MS)) {
      await this.refresh();
    }
    return this.tools;
  }

  /** What the last refresh saw, without refreshing. */
  snapshot(): {
    tools: readonly CatalogTool[];
    failures: ReadonlyMap<string, string>;
  } {
    return { tools: this.tools, failures: this.failures };
  }
}
