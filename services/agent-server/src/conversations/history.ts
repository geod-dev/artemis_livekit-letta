import type { ChatMessage, Modality } from '@artemis/contracts/chat-types';
import type { BackgroundUpdateRecord, DeliveredUpdate, MessageRecord, ToolCallRecord } from '@artemis/storage';

/**
 * Pure projection of stored messages into UI rows (replaces Letta's
 * `normalizeHistory`). Row ids are shared with live SSE events:
 * - user message -> `{role:'user', id: message.id, text: envelope.text, attachments, modality, clientMessageId}`
 *   preceded by one `event` row per delivered update (`id: <updateId>`);
 * - assistant content block i -> `reasoning` / `assistant` row `id: <messageId>:<i>`;
 *   tool_use -> `tool` row `id: <toolCallId>` joined with its `tool_calls` record
 *   (result text, isError, display, task);
 * - tool_result user messages produce no rows.
 * Subagent transcripts (`taskId` set) and soft-deleted messages are skipped.
 */
export function projectHistory(input: {
  messages: readonly MessageRecord[];
  toolCalls: readonly ToolCallRecord[];
  updates: readonly BackgroundUpdateRecord[];
}): ChatMessage[] {
  const callsById = new Map(input.toolCalls.map((call) => [call.id, call]));
  const updatesById = new Map(input.updates.map((update) => [update.id, update]));
  const rows: ChatMessage[] = [];

  for (const message of input.messages) {
    if (message.deletedAt || message.taskId !== null) continue;
    if (message.role === 'user') {
      rows.push(...projectUserMessage(message, updatesById));
    } else {
      rows.push(...projectAssistantMessage(message, callsById));
    }
  }
  return rows;
}

/** Label of a background update row, shared with the live `task` events. */
export function updateLabel(
  title: string,
  status: DeliveredUpdate['status'] | BackgroundUpdateRecord['status'],
  needsInput: boolean
): string {
  if (needsInput) return `${title} needs your input`;
  if (status === 'failed') return `${title} failed`;
  if (status === 'cancelled') return `${title} cancelled`;
  return `${title} completed`;
}

function projectUserMessage(
  message: MessageRecord,
  updatesById: ReadonlyMap<string, BackgroundUpdateRecord>
): ChatMessage[] {
  const envelope = message.envelope;
  // Tool-result carriers and anything without an envelope are not visible rows.
  if (!envelope) return [];
  const rows: ChatMessage[] = envelope.updates.map((update) => {
    const record = updatesById.get(update.id);
    return {
      id: update.id,
      role: 'event' as const,
      kind: 'task_result' as const,
      text: updateLabel(update.title, update.status, update.needsInput),
      updateId: update.id,
      taskId: update.taskId,
      status: update.status,
      ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
      detail: update.report,
      ...(record?.unread !== undefined ? { unread: record.unread } : {}),
      createdAt: message.createdAt,
    };
  });
  const attachments = envelope.attachments;
  if (envelope.text.trim() || attachments.length) {
    const modality: Modality = envelope.mode === 'text' ? 'text' : 'voice';
    rows.push({
      id: message.id,
      role: 'user',
      text: envelope.text,
      modality,
      ...(attachments.length ? { attachments } : {}),
      ...(envelope.clientMessageId ? { clientMessageId: envelope.clientMessageId } : {}),
      createdAt: message.createdAt,
    });
  }
  return rows;
}

function projectAssistantMessage(
  message: MessageRecord,
  callsById: ReadonlyMap<string, ToolCallRecord>
): ChatMessage[] {
  const rows: ChatMessage[] = [];
  message.content.forEach((block, index) => {
    if (!isRecord(block)) return;
    const id = `${message.id}:${index}`;
    if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
      rows.push({ id, role: 'reasoning', text: block.text, createdAt: message.createdAt });
    } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      rows.push({ id, role: 'assistant', text: block.text, createdAt: message.createdAt });
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      const call = callsById.get(block.id);
      rows.push({
        id: block.id,
        role: 'tool',
        toolCallId: block.id,
        name: block.name,
        args: JSON.stringify(block.input ?? {}),
        ...(call?.resultText != null ? { result: call.resultText } : {}),
        ...(call ? { isError: call.isError } : {}),
        ...(call?.display ? { display: call.display } : {}),
        ...(call?.taskRef ? { task: call.taskRef } : {}),
        createdAt: message.createdAt,
      });
    }
  });
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
