import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServer } from '@artemis/contracts/chat-types';
import { type ArtifactSink, type ListedTool, McpClient, type McpCallResult } from '../client.ts';
import { McpResultConverter, recordOf } from './results.ts';

export interface SdkMcpClientOptions {
  artifacts: ArtifactSink;
  /** Per-operation deadline (default 120 s). */
  deadlineMs?: number;
  /** Max tools listed per server (default 500, 20 pages). */
  maxTools?: number;
  /** Working directory and extra env for stdio servers (the server's own `env` wins). */
  stdio?: { cwd?: string; env?: Record<string, string> };
}

const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_MAX_TOOLS = 500;
const MAX_TOOL_PAGES = 20;
const CONNECT_TIMEOUT_MS = 15_000;
const CLIENT_INFO = { name: 'artemis-agent-server', version: '1' };

/** Validate one `tools/list` entry (the subset the bridge uses); null when it has no usable name. */
export function adaptListedTool(value: unknown): ListedTool | null {
  const item = recordOf(value);
  if (!item || typeof item.name !== 'string' || !item.name.trim()) return null;
  const description = item.description;
  const inputSchema = item.inputSchema;
  const schemaRecord = recordOf(inputSchema);
  const annotations = recordOf(item.annotations);
  if (description !== undefined && typeof description !== 'string') {
    throw new Error(`MCP tool ${item.name} has an invalid description`);
  }
  if (inputSchema !== undefined && !schemaRecord) throw new Error(`MCP tool ${item.name} has an invalid input schema`);
  if (item.annotations !== undefined && !annotations) throw new Error(`MCP tool ${item.name} has invalid annotations`);
  const readOnlyHint = annotations?.readOnlyHint;
  if (readOnlyHint !== undefined && typeof readOnlyHint !== 'boolean') {
    throw new Error(`MCP tool ${item.name} has an invalid read-only annotation`);
  }
  return {
    name: item.name,
    ...(typeof description === 'string' ? { description } : {}),
    ...(schemaRecord ? { inputSchema: schemaRecord } : {}),
    ...(typeof readOnlyHint === 'boolean' ? { annotations: { readOnlyHint } } : {}),
  };
}

/**
 * `@modelcontextprotocol/sdk` client over Streamable HTTP, SSE and stdio. One
 * session per operation (listing and calls are seconds apart; a long-lived
 * session would have to survive restarts and idle stdio processes); sessions
 * still open when `close()` runs are closed then.
 */
export class SdkMcpClient extends McpClient {
  private readonly open = new Set<Client>();
  private readonly converter: McpResultConverter;
  private readonly deadlineMs: number;
  private readonly maxTools: number;

  constructor(readonly options: SdkMcpClientOptions) {
    super();
    this.converter = new McpResultConverter(options.artifacts);
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.maxTools = options.maxTools ?? DEFAULT_MAX_TOOLS;
  }

  listTools(server: McpServer, signal?: AbortSignal): Promise<ListedTool[]> {
    return this.withSession(server, signal, async (client, deadline) => {
      const tools: ListedTool[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        if (pages >= MAX_TOOL_PAGES) throw new Error(`MCP server exceeded ${MAX_TOOL_PAGES} tool pages`);
        pages += 1;
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: remainingMs(deadline, this.deadlineMs), signal });
        if (!Array.isArray(page.tools)) throw new Error('MCP tools/list returned an invalid tools array');
        for (const raw of page.tools) {
          const item = adaptListedTool(raw);
          if (!item) continue;
          if (tools.length >= this.maxTools) throw new Error(`MCP server exceeded ${this.maxTools} tools`);
          tools.push(item);
        }
        const next: unknown = page.nextCursor;
        if (next !== undefined && (typeof next !== 'string' || !next || seenCursors.has(next))) {
          throw new Error('MCP tools/list returned an invalid or repeated cursor');
        }
        if (typeof next === 'string') seenCursors.add(next);
        cursor = typeof next === 'string' ? next : undefined;
      } while (cursor);
      return tools;
    });
  }

  callTool(
    server: McpServer,
    tool: string,
    args: Record<string, unknown>,
    options: { conversationId: string; signal?: AbortSignal }
  ): Promise<McpCallResult> {
    return this.withSession(server, options.signal, async (client, deadline) => {
      const result: unknown = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: remainingMs(deadline, this.deadlineMs),
        signal: options.signal,
      });
      if (server.managed?.type === 'device' && tool === 'screenshot_capture') {
        return this.converter.screenshot(result, server.managed.deviceName, options.conversationId);
      }
      return this.converter.convert(result, options.conversationId);
    });
  }

  async close(): Promise<void> {
    const sessions = [...this.open];
    this.open.clear();
    await Promise.all(sessions.map((client) => client.close().catch(() => undefined)));
  }

  private async withSession<T>(
    server: McpServer,
    signal: AbortSignal | undefined,
    run: (client: Client, deadline: number) => Promise<T>
  ): Promise<T> {
    const deadline = Date.now() + this.deadlineMs;
    const client = new Client(CLIENT_INFO);
    this.open.add(client);
    try {
      await client.connect(this.transportFor(server), {
        timeout: Math.min(CONNECT_TIMEOUT_MS, remainingMs(deadline, this.deadlineMs)),
        signal,
      });
      return await run(client, deadline);
    } finally {
      this.open.delete(client);
      await client.close().catch(() => undefined);
    }
  }

  private transportFor(server: McpServer) {
    const transport = server.transport ?? 'stdio';
    if (transport === 'stdio') {
      if (!server.command) throw new Error(`MCP server ${server.name} has no command`);
      return new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: { ...this.options.stdio?.env, ...server.env },
        cwd: this.options.stdio?.cwd,
      });
    }
    if (!server.url) throw new Error(`MCP server ${server.name} has no url`);
    const url = new URL(server.url);
    const requestInit = server.headers ? { headers: server.headers } : undefined;
    return transport === 'sse'
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  }
}

function remainingMs(deadline: number, deadlineMs: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`MCP request exceeded its ${deadlineMs / 1000} second deadline`);
  return remaining;
}
