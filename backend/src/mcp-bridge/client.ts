/**
 * An MCP client for one server in the shared list, used by the backend
 * directly (the bridge). One session per call, like `letta mcp` itself: calls
 * are seconds apart, and a long-lived session would have to survive server
 * restarts.
 *
 * Only `http` and `sse` servers: a `stdio` server's command is written to run
 * inside the Letta container, not here, so those stay on the skill wrapper
 * (`mcp/skill.ts`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../assistant/config';
import { imageType } from '../assistant/workspace';
import type { McpServer } from '../mcp/settings';

/** A tool as `tools/list` describes it: the subset the bridge uses. */
export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface CallResult {
  text: string;
  isError: boolean;
}

/** What the bridge needs from a server: injectable for tests. */
export interface McpClientPort {
  listTools(server: McpServer): Promise<ListedTool[]>;
  callTool(server: McpServer, tool: string, args: Record<string, unknown>): Promise<CallResult>;
}

export function isBridgeable(server: McpServer): boolean {
  return (server.transport === 'http' || server.transport === 'sse') && Boolean(server.url);
}

function transportFor(server: McpServer) {
  const url = new URL(server.url ?? '');
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  return server.transport === 'sse'
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

/** Text blocks joined; anything else (images, resources) is named, not inlined. */
export function textOfResult(result: unknown): CallResult {
  const record = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const block of Array.isArray(record.content) ? record.content : []) {
    const typed = block as { type?: unknown; text?: unknown };
    if (typed?.type === 'text' && typeof typed.text === 'string') parts.push(typed.text);
    else if (typed && typeof typed.type === 'string' && typed.type !== 'image')
      parts.push(`[${typed.type} content omitted]`);
  }
  if (parts.length === 0 && record.structuredContent !== undefined) {
    parts.push(JSON.stringify(record.structuredContent, null, 2));
  }
  return { text: parts.join('\n').trim(), isError: record.isError === true };
}

/** Save device screenshots into the agent's shared workspace and return both
 * an inline workspace image and its absolute path inside the agent container. */
async function deviceScreenshotResult(
  result: unknown,
  deviceName: string
): Promise<CallResult> {
  const record = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const images = content.filter(
    (block): block is { type: 'image'; data: string; mimeType: string } =>
      !!block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'image' &&
      typeof (block as { data?: unknown }).data === 'string' &&
      typeof (block as { mimeType?: unknown }).mimeType === 'string'
  );
  if (images.length === 0) return textOfResult(result);
  if (images.length > 1) throw new Error('A screenshot result may contain only one image');
  const image = images[0]!;
  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (
    image.mimeType !== 'image/png' ||
    image.data.length > 14_000_000 ||
    !validBase64.test(image.data)
  )
    throw new Error('Screenshot must be a valid PNG of at most 10 MB');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length > 10_000_000 || imageType(bytes) !== 'image/png')
    throw new Error('Screenshot must be a valid PNG of at most 10 MB');

  const safeDevice = deviceName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'device';
  const filename = `${safeDevice}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.png`;
  const relativePath = `screenshots/${filename}`;
  const directory = join(config.workspace.dir, 'screenshots');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), bytes, { flag: 'wx' });

  const text = textOfResult({ ...record, content: content.filter((block) => block !== image) });
  return {
    text: [
      `![Screenshot from ${deviceName}](/workspace/${relativePath})`,
      `Saved to /workspace/${relativePath} (workspace path: ${relativePath}).`,
      text.text,
    ]
      .filter(Boolean)
      .join('\n\n'),
    isError: text.isError,
  };
}

async function withClient<T>(server: McpServer, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'livekit-letta-backend', version: '1' });
  try {
    await client.connect(transportFor(server), { timeout: 15_000 });
    return await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export const mcpClient: McpClientPort = {
  listTools: (server) =>
    withClient(server, async (client) => {
      const tools: ListedTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(...(page.tools as ListedTool[]));
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    }),
  callTool: (server, tool, args) =>
    withClient(server, async (client) => {
      const result = await client.callTool(
        { name: tool, arguments: args },
        undefined,
        { timeout: 120_000 }
      );
      if (server.managed?.type === 'device' && tool === 'screenshot_capture')
        return deviceScreenshotResult(result, server.managed.deviceName);
      return textOfResult(result);
    }),
};
