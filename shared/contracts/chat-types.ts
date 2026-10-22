/**
 * Shared API contracts for the frontend, the gateway (backend/) and the
 * agent-server. Keep this file free of runtime code and imports so every
 * package can consume it as types only.
 */

export type Modality = 'text' | 'voice';

/** Short calls end after the final response has played; long calls stay open until ended. */
export type CallMode = 'short' | 'long';

/** The interaction mode a turn runs in, supplied to the assistant with every turn. */
export type TurnMode = 'text' | 'voice-short' | 'voice-long';

/**
 * Effort for a text-chat turn. Voice uses medium effort with thinking disabled.
 * `xhigh` and `max` are accepted by the agent-server; the UI may offer them.
 */
export type TextEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Context size of the last model request of the conversation (from provider usage). */
export interface ConversationContextUsage {
  usedTokens: number;
  windowTokens: number;
  model: string | null;
  reportedAt: string;
}

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

export type TaskKind = 'agent' | 'command';
export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Conversation-scoped background work: shell commands and subagent workers. */
export interface ConversationTask {
  id: string;
  title: string;
  status: TaskStatus;
  kind?: TaskKind;
  report?: string;
  command?: string;
  /** Tail of the command's output (bounded); the full log is `outputPath`. */
  stdout?: string;
  stderr?: string;
  prompt?: string;
  exitCode?: number | null;
  updateId?: string;
  durationMs?: number;
  /** Subagent definition name (`general-purpose`, `research`, ...). */
  subagentType?: string;
  /** Workspace-relative path of the full command log, when kept. */
  outputPath?: string;
  /** The tool call that started (or moved to the background) this task. */
  toolCallId?: string;
  /** The task this one follows up (a resumed subagent). */
  resumedFromTaskId?: string;
  /** The subagent task that started this one, when nested. */
  parentTaskId?: string;
  needsInput?: boolean;
  startedAt?: string;
  endedAt?: string;
}

/**
 * How a tool call relates to a background task. Replaces the frontend's regex
 * parsing of tool-result texts.
 */
export interface ToolTaskRef {
  taskId: string;
  kind: TaskKind;
  /**
   * `started`: the call started the task (subagent, `run_in_background`).
   * `backgrounded`: a foreground command outlived the handoff delay and moved to the background.
   * `stopped` / `inspected`: task tools acting on an existing task.
   */
  relation: 'started' | 'backgrounded' | 'stopped' | 'inspected';
  title?: string;
}

/** Structured rendering hints for a tool call, produced by the tool itself. */
export type ToolDisplay =
  | {
      type: 'command';
      command: string;
      description?: string;
      cwd?: string;
      /** Absent while running or once moved to the background. */
      exitCode?: number | null;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
      /** Output was cut for the model; the full log is `outputPath`. */
      truncated?: boolean;
      outputPath?: string;
      timedOut?: boolean;
      background?: { taskId: string; reason: 'requested' | 'handoff' };
    }
  | {
      type: 'file';
      operation: 'read' | 'write' | 'edit' | 'delete' | 'list' | 'search';
      path: string;
      /** Paths listed or matched (bounded). */
      paths?: string[];
      /** Unified diff for `edit`/`write` (bounded). */
      diff?: string;
      lines?: { offset: number; count: number; total?: number };
    }
  | {
      type: 'agent';
      taskId: string;
      subagentType: string;
      title: string;
      prompt: string;
      resumedFromTaskId?: string;
      /** Synchronous run inside a worker: the report is the tool result. */
      synchronous?: boolean;
    }
  | { type: 'task'; operation: 'list' | 'get' | 'stop'; taskIds: string[] }
  | {
      type: 'mcp';
      qualified: string;
      server?: string;
      tool?: string;
      /** Files the MCP result produced (images, audio, resources) saved in the workspace. */
      artifacts?: ChatAttachment[];
    }
  | { type: 'present' }
  | { type: 'call'; action: 'set_mode' | 'end'; mode?: CallMode };

export type ChatMessage =
  | {
      id: string;
      role: 'user';
      text: string;
      modality: Modality;
      attachments?: ChatAttachment[];
      createdAt?: string;
      /** Client-generated identifier echoed by live events for optimistic UI reconciliation. */
      clientMessageId?: string;
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
      display?: ToolDisplay;
      task?: ToolTaskRef;
      createdAt?: string;
    }
  | {
      /** System-generated notes worth showing: background task results. `memory` is no longer emitted. */
      id: string;
      role: 'event';
      kind: 'task_result' | 'memory';
      text: string;
      /** Background update this row delivers; its response follows it. */
      updateId?: string;
      /** The background task whose result this row delivers. */
      taskId?: string;
      status?: 'completed' | 'failed' | 'cancelled';
      durationMs?: number;
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
      display?: ToolDisplay;
      task?: ToolTaskRef;
    }
  | { type: 'turn_end'; turnId: string; success: boolean; error?: string }
  | { type: 'task'; taskId: string; status: 'running' | 'finished'; title: string; kind?: TaskKind }
  /** Background updates whose read state changed (held results, read markers). */
  | { type: 'updates_changed' }
  /** A fresh context-usage snapshot is available (`GET .../context-usage`). */
  | { type: 'context_usage' }
  | { type: 'conversation_updated'; conversation: ConversationSummary }
  | {
      type: 'snapshot';
      turns: Array<{ turnId: string; modality: Modality }>;
      tasks: Array<{ taskId: string; status: 'running' | 'finished'; title: string }>;
      activeEvents: Array<Exclude<ConversationEvent, { type: 'snapshot' }>>;
    };

/** Live events about the conversation list (SSE). */
export type ConversationListEvent = { type: 'unread'; conversationId: string; unread: number };

/** How an MCP server is reached: a command run by the agent-server, or a URL. */
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
  /** Registered automatically while an external device is connected. */
  managed?: {
    type: 'device';
    deviceName: string;
    connectedAt: string;
    tools: number;
  };
}

/** `GET`/`PUT /api/mcp`: the shared list, and what the `mcp_*` bridge tools reach of it. */
export interface McpSettingsResponse {
  revision: string;
  servers: McpServer[];
  diagnostics: Array<{ index: number; diagnostic: string; value: unknown }>;
  sync?: {
    saved: true;
    catalog: 'synced' | 'failed' | 'pending';
    /** @deprecated Never sent by the agent-server and not shown in the UI; removed with the contract cleanup. */
    skill?: 'synced' | 'failed' | 'pending';
    /** @deprecated Never sent by the agent-server and not shown in the UI; removed with the contract cleanup. */
    mod?: 'synced' | 'failed' | 'pending';
    retryableRevision: string;
  };
  bridge: {
    /** Servers whose tools the bridge listed. */
    servers: string[];
    tools: number;
    /** Server name -> why it did not list its tools. */
    failures: Record<string, string>;
  };
}
