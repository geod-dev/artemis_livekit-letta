import { notImplemented } from '@artemis/core';
import type { ChatMessage } from '@artemis/contracts/chat-types';
import type { BackgroundUpdateRecord, MessageRecord, ToolCallRecord } from '@artemis/storage';

/**
 * Pure projection of stored messages into UI rows (replaces Letta's
 * `normalizeHistory`). Row ids are shared with live SSE events:
 * - user message -> `{role:'user', id: message.id, text: envelope.text, attachments, modality, clientMessageId}`
 *   preceded by one `event` row per delivered update (`id: <updateId>`);
 * - assistant content block i -> `reasoning` / `assistant` row `id: <messageId>:<i>`;
 *   tool_use -> `tool` row `id: <toolCallId>` joined with its `tool_calls` record
 *   (result text, isError, display, task);
 * - tool_result user messages produce no rows.
 */
export function projectHistory(_input: {
  messages: readonly MessageRecord[];
  toolCalls: readonly ToolCallRecord[];
  updates: readonly BackgroundUpdateRecord[];
}): ChatMessage[] {
  return notImplemented('projectHistory');
}
