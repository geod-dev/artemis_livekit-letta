import type { ChatAttachment, McpServer } from '@artemis/contracts/chat-types';
import { type ArtifactSink, type ListedTool, McpClient, type McpCallResult } from './client.ts';

export interface FakeTool {
  name: string;
  description?: string;
  readOnly?: boolean;
}

export type FakeAnswer = (server: string, tool: string, args: Record<string, unknown>) => McpCallResult;

export const EMPTY_RESULT: McpCallResult = { text: '', isError: false, images: [], artifacts: [] };

/** In-memory MCP servers: `catalog` maps a server name to its tools; `answer` produces call results. */
export class FakeMcpClient extends McpClient {
  readonly calls: string[] = [];
  readonly listed: string[] = [];
  readonly failing = new Set<string>();
  readonly unreachable = new Set<string>();

  constructor(
    private readonly catalog: Record<string, FakeTool[]> = {},
    private readonly answer: FakeAnswer = (server, tool) => ({
      ...EMPTY_RESULT,
      text: `ran ${tool} on ${server}`,
    })
  ) {
    super();
  }

  async listTools(server: McpServer): Promise<ListedTool[]> {
    this.listed.push(server.name);
    if (this.failing.has(server.name)) throw new Error('401');
    return (this.catalog[server.name] ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      annotations: { readOnlyHint: tool.readOnly === true },
    }));
  }

  async callTool(
    server: McpServer,
    tool: string,
    args: Record<string, unknown>
  ): Promise<McpCallResult> {
    if (this.unreachable.has(server.name)) throw new Error('connection refused');
    this.calls.push(`${server.name}.${tool} ${JSON.stringify(args)}`);
    return this.answer(server.name, tool, args);
  }

  async close(): Promise<void> {}
}

export interface SavedArtifact {
  conversationId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  attachment: ChatAttachment;
}

/** Artifact sink that keeps the bytes in memory. */
export class MemoryArtifactSink implements ArtifactSink {
  readonly saved: SavedArtifact[] = [];

  async save(input: { conversationId: string; name: string; mimeType: string; bytes: Uint8Array }): Promise<ChatAttachment> {
    const attachment: ChatAttachment = {
      path: `data/artifacts/${input.conversationId}/${input.name}`,
      name: input.name,
      kind: input.mimeType.startsWith('image/') ? 'image' : 'file',
      mimeType: input.mimeType,
      size: input.bytes.length,
    };
    this.saved.push({ ...input, attachment });
    return attachment;
  }
}
