/**
 * Agent-server HTTP/SSE API DTOs (service-to-service, behind the gateway).
 * Types only. Routes live under `/v1` and require
 * `Authorization: Bearer <AGENT_SERVER_TOKEN>`; see
 * docs/migration-hindsight/architecture.md#agent-server-api for the route table.
 *
 * Most conversation routes return the same shapes the frontend already uses
 * (`chat-types.ts`), so the gateway proxies them byte-for-byte.
 */
import type {
  CallMode,
  ChatAttachment,
  ConversationSummary,
  McpServer,
  TextEffort,
} from './chat-types.ts';

/** Error body of every non-2xx response. */
export interface AgentServerError {
  error: string;
  /** Stable machine code, e.g. `conversation_not_found`, `busy`, `revision_conflict`. */
  code?: string;
}

/** `GET /health` (liveness) and `GET /ready` (storage + MCP catalog ready; memory is optional). */
export interface AgentServerReadiness {
  status: 'ok' | 'degraded' | 'unavailable';
  storage: boolean;
  mcp: boolean;
  /** Hindsight reachability; memory failures never block turns. */
  memory: boolean;
}

/** `GET /v1/conversations?limit=&after=` */
export interface ListConversationsQuery {
  limit?: number;
  /** Cursor: id of the last conversation of the previous page. */
  after?: string;
}

/** `POST /v1/conversations` -> `ConversationSummary` (prompt snapshot frozen at creation). */
export interface CreateConversationRequest {
  title?: string;
}

/** `PATCH /v1/conversations/:id` -> `ConversationSummary` */
export interface RenameConversationRequest {
  title: string;
}

/** `POST /v1/conversations/:id/turns` -> 202 `TurnAccepted` | 429 `AgentServerError{code:'busy'}` */
export interface TextTurnRequest {
  text: string;
  effort?: TextEffort;
  /** Files the gateway already saved in the workspace (`data/attachments/...`). */
  attachments?: ChatAttachment[];
  clientMessageId?: string;
}

export interface TurnAccepted {
  accepted: true;
  turnId: string;
}

/** `POST /v1/conversations/:id/cancel` */
export interface CancelResponse {
  cancelled: boolean;
}

/** `POST /v1/conversations/:id/read` */
export interface MarkReadRequest {
  updateIds: string[];
}
export interface MarkReadResponse {
  read: number;
}

/**
 * `DELETE /v1/conversations/:id/messages/:messageId`: soft-deletes the message
 * and everything after it, in place. The conversation id does not change.
 */
export interface RewindResponse {
  conversation: ConversationSummary | null;
}

/** `POST /v1/conversations/:id/warm` - pre-spawn the main worker before a call. */
export interface WarmRequest {
  modality: 'text' | 'voice';
}

/**
 * `PUT /v1/mcp/managed`: the gateway's full list of connection-managed servers
 * (connected devices). Replaces the previous list; `managed` must be set on each.
 */
export interface ManagedMcpServersRequest {
  servers: McpServer[];
}

/* ------------------------------------------------------------------ voice */

/**
 * `POST /v1/voice/conversations/:id/chat/completions`: OpenAI-compatible
 * streaming chat completions used by the LiveKit voice agent (subset read).
 * Response: `text/event-stream` of `chat.completion.chunk`, `model: "artemis"`.
 * Header `x-voice-call-id` is forwarded by the gateway.
 */
export interface VoiceChatCompletionRequest {
  model?: string;
  stream?: boolean;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
    content: string | Array<{ type: string; text?: string }> | null;
    /** LiveKit chat item id, used for utterance deduplication. */
    id?: string;
  }>;
}

/** `GET /v1/voice/conversations/:id/call?mode=` SSE control channel events. */
export type CallControlEvent = { type: 'update'; id: string };

/** `GET /v1/voice/conversations/:id/call/state` */
export interface CallStateResponse {
  mode: CallMode;
  next: 'end' | 'listen';
}

/** `POST /v1/voice/conversations/:id/call/updates/:updateId/ack` */
export interface CallUpdateAckRequest {
  heard: boolean;
}
