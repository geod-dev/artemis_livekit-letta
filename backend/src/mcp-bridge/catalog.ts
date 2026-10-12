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

/** Lower-cased words, plurals folded ("calendars" matches "calendar"). */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** Keyword ranking over name and description; name matches weigh more. */
export function searchCatalog(
  tools: readonly CatalogTool[],
  query: string,
  options: { server?: string; limit?: number } = {}
): CatalogTool[] {
  const terms = words(query);
  const scoped = options.server
    ? tools.filter((t) => t.server.name.toLowerCase() === options.server?.toLowerCase())
    : tools;
  if (terms.length === 0) return scoped.slice(0, options.limit ?? 8);
  const scored = scoped
    .map((tool) => {
      const name = words(tool.tool.replace(/_/g, ' '));
      const description = new Set(words(tool.description));
      let score = 0;
      for (const term of terms) {
        if (name.some((w) => w === term)) score += 3;
        // Compound names: "busy" in "freebusy", "label" in "labels".
        else if (name.some((w) => w.includes(term) || term.startsWith(w))) score += 2;
        if (description.has(term)) score += 1;
      }
      return { tool, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.qualified.localeCompare(b.tool.qualified));
  return scored.slice(0, options.limit ?? 8).map((entry) => entry.tool);
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
      changed?: () => Promise<void>;
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
        const failures = new Map<string, string>();
        const lists = await Promise.all(
          servers.map(async (server) => {
            try {
              return toCatalogTools(server, await this.deps.client.listTools(server));
            } catch (error) {
              failures.set(server.name, error instanceof Error ? error.message : String(error));
              return [];
            }
          })
        );
        this.tools = lists.flat();
        this.failures = failures;
        this.fetchedAt = this.now();
        for (const [name, reason] of failures) {
          this.deps.log?.(`MCP bridge: ${name} did not list tools (${reason})`);
        }
        await this.deps.changed?.();
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
  snapshot(): { tools: readonly CatalogTool[]; failures: ReadonlyMap<string, string> } {
    return { tools: this.tools, failures: this.failures };
  }
}
