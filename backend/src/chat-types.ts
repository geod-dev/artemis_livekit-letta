/**
 * The backend's API types. The frontend imports them as types only, so this
 * file must stay free of runtime code and imports.
 */

export type Modality = 'text' | 'voice';

/** Short calls end after the final response has played; long calls stay open until ended. */
export type CallMode = 'short' | 'long';

/** The interaction mode a turn runs in, supplied to the assistant with every turn. */
export type TurnMode = 'text' | 'voice-short' | 'voice-long';

/** User-selected model for a text-chat turn. Voice calls retain their own model. */
export type TextEffort = 'fast' | 'low' | 'medium' | 'high';

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string | null;
  /** Background results not yet read in the chat or heard in a call. */
  unread?: number;
}

/**
 * A file the user attached, stored in the agent's workspace; images are also
 * shown to the model inline.
 */
export interface ChatAttachment {
  /** Path in the workspace: `data/attachments/<uuid>/<file name>`. */
  path: string;
  name: string;
  kind: 'image' | 'file';
  mimeType?: string;
  size?: number;
}

export type ChatMessage =
  | {
      id: string;
      role: 'user';
      text: string;
      modality: Modality;
      attachments?: ChatAttachment[];
      createdAt?: string;
    }
  | {
      id: string;
      role: 'assistant' | 'reasoning';
      text: string;
      createdAt?: string;
    }
  | {
      id: string;
      role: 'tool';
      toolCallId: string;
      name: string;
      args?: string;
      result?: string;
      isError?: boolean;
      createdAt?: string;
    }
  | {
      /** System-generated notes worth showing: background task results, memory updates. */
      id: string;
      role: 'event';
      kind: 'task_result' | 'memory';
      text: string;
      /** Background update this row delivers; its response follows it. */
      updateId?: string;
      /** The worker's full report. */
      detail?: string;
      /** The update and its response have not been read or heard yet. */
      unread?: boolean;
      createdAt?: string;
    };

/** Live events pushed to subscribers of a conversation (SSE). */
export type ConversationEvent =
  | { type: 'turn_start'; turnId: string; modality: Modality }
  | { type: 'message'; turnId: string; message: ChatMessage }
  | { type: 'assistant_delta'; turnId: string; messageId: string; text: string }
  | { type: 'reasoning_delta'; turnId: string; messageId: string; text: string }
  | { type: 'tool_call'; turnId: string; toolCallId: string; name: string }
  /** `args` holds the call's complete arguments, which `tool_call` does not carry. */
  | {
      type: 'tool_result';
      turnId: string;
      toolCallId: string;
      args?: string;
      result: string;
      isError: boolean;
    }
  | { type: 'turn_end'; turnId: string; success: boolean; error?: string }
  | { type: 'task'; taskId: string; status: 'running' | 'finished'; title: string }
  /** Background updates whose read state changed (held results, read markers). */
  | { type: 'updates_changed' }
  | { type: 'conversation_updated'; conversation: ConversationSummary };

/** Live events about the conversation list (SSE). */
export type ConversationListEvent = { type: 'unread'; conversationId: string; unread: number };

/** How an MCP server is reached: a command in the Letta container, or a URL. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/** One server of the shared MCP list (Settings -> MCP servers). */
export interface McpServer {
  name: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** `GET`/`PUT /api/mcp`: the shared list, and what the native `mcp_*` tools reach of it. */
export interface McpSettingsResponse {
  servers: McpServer[];
  bridge: {
    /** Servers whose tools the bridge listed. */
    servers: string[];
    tools: number;
    /** Server name -> why it did not list its tools. */
    failures: Record<string, string>;
  };
}
