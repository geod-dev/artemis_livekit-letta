import { notImplemented } from '@artemis/core';
import type { McpServer } from '@artemis/contracts/chat-types';
import { type ArtifactSink, McpClient, type McpCallResult, type ListedTool } from '../client.ts';

export interface SdkMcpClientOptions {
  artifacts: ArtifactSink;
  /** Per-call deadline (default 120 s). */
  deadlineMs?: number;
  /** Max tools listed per server (default 500, 20 pages). */
  maxTools?: number;
  /** Working directory and env for stdio servers. */
  stdio?: { cwd: string; env?: Record<string, string> };
}

/** `@modelcontextprotocol/sdk` client (port of backend/src/mcp-bridge/client.ts, artifactization included). */
export class SdkMcpClient extends McpClient {
  constructor(readonly options: SdkMcpClientOptions) {
    super();
  }

  listTools(_server: McpServer, _signal?: AbortSignal): Promise<ListedTool[]> {
    return notImplemented('SdkMcpClient.listTools');
  }
  callTool(
    _server: McpServer,
    _tool: string,
    _args: Record<string, unknown>,
    _options: { conversationId: string; signal?: AbortSignal }
  ): Promise<McpCallResult> {
    return notImplemented('SdkMcpClient.callTool');
  }
  close(): Promise<void> {
    return notImplemented('SdkMcpClient.close');
  }
}
