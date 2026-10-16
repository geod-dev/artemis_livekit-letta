import type { ChatMessage, ConversationEvent } from '@shared/chat-types';
import { isRecord } from './api.ts';

const boundedString = (value: unknown, max = 1_000_000): value is string =>
  typeof value === 'string' && value.length <= max;
const optionalString = (value: unknown, max = 1_000_000) =>
  value === undefined || boundedString(value, max);
const isAttachment = (value: unknown) =>
  isRecord(value) &&
  boundedString(value.path, 4096) &&
  boundedString(value.name, 512) &&
  (value.kind === 'image' || value.kind === 'file') &&
  optionalString(value.mimeType, 255) &&
  (value.size === undefined || (typeof value.size === 'number' && Number.isFinite(value.size)));

export function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value) || !boundedString(value.id, 512) || typeof value.role !== 'string')
    return false;
  if (value.role === 'user')
    return (
      boundedString(value.text) &&
      (value.modality === 'text' || value.modality === 'voice') &&
      optionalString(value.clientMessageId, 200) &&
      optionalString(value.createdAt, 128) &&
      (value.attachments === undefined ||
        (Array.isArray(value.attachments) &&
          value.attachments.length <= 10 &&
          value.attachments.every(isAttachment)))
    );
  if (value.role === 'assistant' || value.role === 'reasoning')
    return boundedString(value.text) && optionalString(value.createdAt, 128);
  if (value.role === 'tool')
    return (
      boundedString(value.toolCallId, 512) &&
      boundedString(value.name, 512) &&
      optionalString(value.args) &&
      optionalString(value.result) &&
      (value.isError === undefined || typeof value.isError === 'boolean') &&
      optionalString(value.createdAt, 128)
    );
  return (
    value.role === 'event' &&
    boundedString(value.text) &&
    (value.kind === 'task_result' || value.kind === 'memory') &&
    optionalString(value.updateId, 512) &&
    optionalString(value.taskId, 512) &&
    (value.durationMs === undefined ||
      (typeof value.durationMs === 'number' &&
        Number.isFinite(value.durationMs) &&
        value.durationMs >= 0)) &&
    (value.status === undefined ||
      ['completed', 'failed', 'cancelled'].includes(value.status as string)) &&
    optionalString(value.detail) &&
    (value.unread === undefined || typeof value.unread === 'boolean') &&
    optionalString(value.createdAt, 128)
  );
}

/** Reject malformed or unknown SSE payloads before they reach the state store. */
export function isConversationEvent(value: unknown): value is ConversationEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  const string = (key: string, max?: number) => boundedString(value[key], max);
  switch (value.type) {
    case 'turn_start':
      return string('turnId') && (value.modality === 'text' || value.modality === 'voice');
    case 'message':
      return string('turnId') && isChatMessage(value.message);
    case 'assistant_delta':
    case 'reasoning_delta':
      return string('turnId') && string('messageId') && string('text');
    case 'tool_call':
      return string('turnId') && string('toolCallId') && string('name');
    case 'tool_result':
      return (
        string('turnId') &&
        string('toolCallId') &&
        string('result') &&
        typeof value.isError === 'boolean'
      );
    case 'turn_end':
      return (
        string('turnId', 512) &&
        typeof value.success === 'boolean' &&
        optionalString(value.error, 4096)
      );
    case 'task':
      return (
        string('taskId', 512) &&
        (value.status === 'running' || value.status === 'finished') &&
        string('title', 512)
      );
    case 'updates_changed':
    case 'context_usage':
      return true;
    case 'conversation_updated':
      return (
        isRecord(value.conversation) &&
        boundedString(value.conversation.id, 512) &&
        boundedString(value.conversation.title, 512) &&
        (value.conversation.updatedAt === null ||
          optionalString(value.conversation.updatedAt, 128)) &&
        (value.conversation.unread === undefined || typeof value.conversation.unread === 'number')
      );
    case 'snapshot':
      return (
        Array.isArray(value.turns) &&
        value.turns.length <= 256 &&
        value.turns.every(
          (t) =>
            isRecord(t) &&
            boundedString(t.turnId, 512) &&
            (t.modality === 'text' || t.modality === 'voice')
        ) &&
        Array.isArray(value.tasks) &&
        value.tasks.length <= 1024 &&
        value.tasks.every(
          (t) =>
            isRecord(t) &&
            boundedString(t.taskId, 512) &&
            (t.status === 'running' || t.status === 'finished') &&
            boundedString(t.title, 512)
        ) &&
        Array.isArray(value.activeEvents) &&
        value.activeEvents.length <= 1024 &&
        value.activeEvents.every(
          (event) => isRecord(event) && event.type !== 'snapshot' && isConversationEvent(event)
        )
      );
    default:
      return false;
  }
}
