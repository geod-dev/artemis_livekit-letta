import type { ImageMediaType } from '@artemis/core';
import type { ChatAttachment, McpServer } from '@artemis/contracts/chat-types';

/** A tool as `tools/list` describes it (the subset used). */
export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

export interface InlineImage {
  mediaType: ImageMediaType;
  /** Base64, no `data:` prefix. */
  data: string;
}

export interface McpCallResult {
  /** Model-facing text (the MCP result envelope, bounded by the caller). */
  text: string;
  isError: boolean;
  /** Small images inlined for the model. */
  images: InlineImage[];
  /** Binary results saved in the workspace (`data/artifacts/...`). */
  artifacts: ChatAttachment[];
}

/** Where binary MCP results are written (backed by the WorkspaceTransport). */
export interface ArtifactSink {
  save(input: {
    conversationId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<ChatAttachment>;
}

/**
 * Talks to MCP servers. `SdkMcpClient` (`@artemis/mcp/sdk`) uses
 * `@modelcontextprotocol/sdk` (Streamable HTTP, SSE, stdio spawned by the
 * agent-server). Injectable for tests.
 */
export abstract class McpClient {
  abstract listTools(server: McpServer, signal?: AbortSignal): Promise<ListedTool[]>;
  abstract callTool(
    server: McpServer,
    tool: string,
    args: Record<string, unknown>,
    options: { conversationId: string; signal?: AbortSignal }
  ): Promise<McpCallResult>;
  /** Close open sessions and stdio processes. */
  abstract close(): Promise<void>;
}
