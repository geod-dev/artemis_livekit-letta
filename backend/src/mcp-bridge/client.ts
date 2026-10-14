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
import { createAttachmentReferenceToken } from '../assistant/filesystem/attachment-retention';
import { imageType, MAX_ATTACHMENT_BYTES, saveMcpArtifact } from '../assistant/filesystem/workspace-adapter.ts';
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

const MAX_TOOL_PAGES = 20;
const MAX_TOOLS = 500;
const MCP_DEADLINE_MS = 120_000;

export function isBridgeable(server: McpServer): boolean {
  return (server.transport === 'http' || server.transport === 'sse') && Boolean(server.url);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function adaptListedTool(value: unknown): ListedTool | null {
  const item = recordOf(value);
  if (!item || typeof item.name !== 'string' || !item.name.trim()) return null;
  const description = item.description;
  const inputSchema = item.inputSchema;
  const schemaRecord = recordOf(inputSchema);
  const annotations = recordOf(item.annotations);
  if (description !== undefined && typeof description !== 'string')
    throw new Error(`MCP tool ${item.name} has an invalid description`);
  if (inputSchema !== undefined && !schemaRecord)
    throw new Error(`MCP tool ${item.name} has an invalid input schema`);
  if (item.annotations !== undefined && !annotations)
    throw new Error(`MCP tool ${item.name} has invalid annotations`);
  const readOnlyHint = annotations?.readOnlyHint;
  if (readOnlyHint !== undefined && typeof readOnlyHint !== 'boolean')
    throw new Error(`MCP tool ${item.name} has an invalid read-only annotation`);
  return {
    name: item.name,
    ...(typeof description === 'string' ? { description } : {}),
    ...(schemaRecord ? { inputSchema: schemaRecord } : {}),
    ...(typeof readOnlyHint === 'boolean' ? { annotations: { readOnlyHint } } : {}),
  };
}

function transportFor(server: McpServer) {
  const url = new URL(server.url ?? '');
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  return server.transport === 'sse'
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

/** Preserve the full MCP result envelope in text until the workspace artifact port is available. */
export function textOfResult(result: unknown): CallResult {
  const record = recordOf(result) ?? {};
  const envelope: Record<string, unknown> = { ...record };
  return {
    text: JSON.stringify(envelope, null, 2) ?? '',
    isError: record.isError === true,
  };
}

/** Artifactize MCP media/resource bytes while preserving the result envelope. */
export async function artifactizeResult(result: unknown, retainedPaths: readonly string[] = []): Promise<CallResult> {
  const record = recordOf(result) ?? {};
  const content = Array.isArray(record.content) ? record.content : [];
  const envelope = { ...record, content: [...content] };
  const files: Array<{ attachment: Awaited<ReturnType<typeof saveMcpArtifact>>; label: string }> = [];
  let artifactBytes = 0;

  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    const blockRecord = recordOf(block);
    if (!blockRecord) continue;
    const item = { ...blockRecord };
    const kind = item.type;
    let bytes: Buffer | null = null;
    let mimeType = '';
    let name = `mcp-${kind ?? 'resource'}-${index + 1}`;
    if ((kind === 'image' || kind === 'audio') && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      bytes = decodeBase64(item.data);
      mimeType = item.mimeType;
      name += extensionForMime(mimeType);
    } else if (kind === 'resource' && recordOf(item.resource)) {
      const resource = { ...recordOf(item.resource)! };
      mimeType = typeof resource.mimeType === 'string' ? resource.mimeType : 'application/octet-stream';
      const uriName = typeof resource.uri === 'string' ? resource.uri.split('/').pop() : '';
      if (uriName) name = safeArtifactName(uriName);
      if (typeof resource.blob === 'string') bytes = decodeBase64(resource.blob);
      else if (typeof resource.text === 'string') {
        if (Buffer.byteLength(resource.text, 'utf8') > MAX_ATTACHMENT_BYTES) throw new Error('MCP resource is larger than 25 MB');
        bytes = Buffer.from(resource.text, 'utf8');
      }
      if (bytes) {
        artifactBytes += bytes.length;
        if (artifactBytes > MAX_ATTACHMENT_BYTES) throw new Error('MCP artifacts exceed 25 MB in total');
        const attachment = await saveMcpArtifact({ bytes, mimeType, name });
        files.push({ attachment, label: 'MCP resource' });
        delete resource.blob;
        delete resource.text;
        resource.artifact = attachment;
        resource.workspaceUrl = workspaceUrl(attachment.path);
        item.resource = resource;
        envelope.content[index] = item;
      }
      continue;
    }
    if (!bytes) continue;
    artifactBytes += bytes.length;
    if (artifactBytes > MAX_ATTACHMENT_BYTES) throw new Error('MCP artifacts exceed 25 MB in total');
    const attachment = await saveMcpArtifact({ bytes, mimeType, name });
    files.push({ attachment, label: kind === 'image' ? 'MCP image' : 'MCP audio' });
    delete item.data;
    item.artifact = attachment;
    item.workspaceUrl = workspaceUrl(attachment.path);
    envelope.content[index] = item;
  }

  const text = textOfResult(envelope);
  const links = files.map(({ attachment, label }) => {
    const url = workspaceUrl(attachment.path);
    return attachment.kind === 'image'
      ? `![${label}](${url})\nSaved to ${url}`
      : `[${label}: ${attachment.name}](${url})`;
  });
  const token = await createAttachmentReferenceToken([
    ...retainedPaths,
    ...files.map(({ attachment }) => attachment.path),
  ]);
  const marker = token ? `[[mcp-managed-artifacts:v1:${token}]]` : '';
  return { text: [marker, ...links, text.text].filter(Boolean).join('\n\n'), isError: text.isError };
}

function decodeBase64(data: string): Buffer {
  if (data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error('MCP media must be valid base64 of at most 25 MB');
  }
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('MCP media must be valid base64 of at most 25 MB');
  return bytes;
}

function extensionForMime(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.m4a',
  };
  return extensions[mimeType] ?? '';
}

function safeArtifactName(name: string): string {
  return name.replace(/[\\/\0-\x1f<>:"|?*]/g, '_').slice(-120) || 'mcp-resource';
}

function workspaceUrl(path: string): string {
  return `/api/workspace/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Save device screenshots into the agent's shared workspace and return both
 * an inline workspace image and its absolute path inside the agent container. */
async function deviceScreenshotResult(result: unknown, deviceName: string): Promise<CallResult> {
  const record = recordOf(result) ?? {};
  const content = Array.isArray(record.content) ? record.content : [];
  const images = content.flatMap((block) => {
    const item = recordOf(block);
    return item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string'
      ? [{ block, data: item.data, mimeType: item.mimeType }]
      : [];
  });
  if (images.length === 0) return textOfResult(result);
  if (images.length > 1) throw new Error('A screenshot result may contain only one image');
  const screenshot = images[0]!;
  const image = { data: screenshot.data, mimeType: screenshot.mimeType };
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
  const artifact = await saveMcpArtifact({
    bytes,
    mimeType: 'image/png',
    name: `${safeDevice}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
  });
  const artifactized = await artifactizeResult({
    ...record,
    content: content.filter((block) => block !== screenshot.block),
  }, [artifact.path]);
  const url = workspaceUrl(artifact.path);
  return {
    text: [
      `![Screenshot from ${deviceName}](${url})`,
      `Saved to ${url} (workspace path: ${artifact.path}).`,
      artifactized.text,
    ]
      .filter(Boolean)
      .join('\n\n'),
    isError: artifactized.isError,
  };
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('MCP request exceeded its 120 second deadline');
  return remaining;
}

async function withClient<T>(
  server: McpServer,
  run: (client: Client, deadline: number) => Promise<T>
): Promise<T> {
  const deadline = Date.now() + MCP_DEADLINE_MS;
  const client = new Client({ name: 'livekit-letta-backend', version: '1' });
  try {
    await client.connect(transportFor(server), {
      timeout: Math.min(15_000, remainingMs(deadline)),
    });
    return await run(client, deadline);
  } finally {
    await client.close().catch(() => {});
  }
}

export const mcpClient: McpClientPort = {
  listTools: (server) =>
    withClient(server, async (client, deadline) => {
      const tools: ListedTool[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      let pages = 0;
      do {
        if (pages >= MAX_TOOL_PAGES)
          throw new Error(`MCP server exceeded ${MAX_TOOL_PAGES} tool pages`);
        pages += 1;
        const page = await client.listTools(cursor ? { cursor } : {}, {
          timeout: remainingMs(deadline),
        });
        if (!Array.isArray(page.tools))
          throw new Error('MCP tools/list returned an invalid tools array');
        for (const rawItem of page.tools) {
          const item = adaptListedTool(rawItem);
          if (!item) continue;
          if (tools.length >= MAX_TOOLS) throw new Error(`MCP server exceeded ${MAX_TOOLS} tools`);
          tools.push(item as ListedTool);
        }
        const next = page.nextCursor;
        if (next !== undefined && (typeof next !== 'string' || !next || seenCursors.has(next))) {
          throw new Error('MCP tools/list returned an invalid or repeated cursor');
        }
        if (typeof next === 'string') seenCursors.add(next);
        cursor = typeof next === 'string' ? next : undefined;
      } while (cursor);
      return tools;
    }),
  callTool: (server, tool, args) =>
    withClient(server, async (client, deadline) => {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: remainingMs(deadline),
      });
      if (server.managed?.type === 'device' && tool === 'screenshot_capture')
        return deviceScreenshotResult(result, server.managed.deviceName);
      return artifactizeResult(result);
    }),
};
