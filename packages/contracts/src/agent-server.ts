/**
 * Agent-server HTTP/SSE API DTOs (service-to-service, behind the gateway).
 * Types, plus the voice dispatch keys and the path builders. Routes live under `/v1` and require
 * `Authorization: Bearer <AGENT_SERVER_TOKEN>`.
 *
 * Most conversation routes return the same shapes the frontend already uses
 * (`chat-types.ts`), so the gateway proxies them byte-for-byte.
 */
import type { CallMode, ChatAttachment, McpServer, TextEffort } from './chat-types.ts';

/** Error body of every non-2xx response. */
export interface AgentServerError {
  error: string;
  /** Stable machine code, e.g. `conversation_not_found`, `busy`, `revision_conflict`. */
  code?: string;
}

/** `POST /v1/conversations/:id/turns` -> 202 `{ accepted: true, turnId }` | 429 `AgentServerError{code:'busy'}` */
export interface TextTurnRequest {
  text: string;
  effort?: TextEffort;
  /** Files the gateway already saved in the workspace (`data/attachments/...`). */
  attachments?: ChatAttachment[];
  clientMessageId?: string;
}

/**
 * `DELETE /v1/conversations/:id/messages/:messageId`: soft-deletes the message
 * and everything after it, in place. The conversation id does not change.
 * `attachments` lists the workspace paths of the user-message attachments that
 * remain after the delete.
 */
export interface MessageDeleteResponse {
  attachments: string[];
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

/** `GET /v1/voice/conversations/:id/call?mode=` SSE control channel events. */
export type CallControlEvent = { type: 'update'; id: string };

/** `GET /v1/voice/conversations/:id/call/state` */
export interface CallStateResponse {
  mode: CallMode;
  next: 'end' | 'listen';
}

/**
 * Room dispatch metadata keys. The Python voice agent copies these literals
 * (apps/voice-agent); keep both sides in step.
 */
export const VOICE_DISPATCH_KEYS = { conversationId: 'conversation_id', callMode: 'call_mode' } as const;

/** Path of a conversation on the agent-server API. */
export function conversationPath(id: string): string {
  return `/v1/conversations/${encodeURIComponent(id)}`;
}

/** Path of a conversation's voice routes on the agent-server API. */
export function voicePath(id: string): string {
  return `/v1/voice/conversations/${encodeURIComponent(id)}`;
}
