import type { ChatMessage, ConversationEvent } from '@artemis/contracts/chat-types';
import { historyCoversMessage } from './conversation-messages.ts';
import type { LiveConversationItem } from './conversation-state.ts';

/** The live items of a conversation: streamed messages, deltas and tool calls, by turn. */
type LiveItems = LiveConversationItem[];

/** A message the stream delivers, kept once per id and role (a reconnect can replay it). */
export function addLiveMessage(items: LiveItems, turnId: string, message: ChatMessage): LiveItems {
  return items.some((item) => item.message.id === message.id && item.message.role === message.role)
    ? items
    : [...items, { turnId, message }];
}

/** Appends a streamed text delta to its message, starting the message at its first delta. */
export function appendLiveDelta(
  items: LiveItems,
  event: Extract<ConversationEvent, { type: 'assistant_delta' | 'reasoning_delta' }>
): LiveItems {
  const role = event.type === 'reasoning_delta' ? 'reasoning' : 'assistant';
  // Reasoning history rows use the same canonical prefix as the
  // assistant-ui adapter, while assistant rows use the message ID.
  const id = role === 'reasoning' ? `reasoning:${event.messageId}` : event.messageId;
  const index = items.findIndex((item) => item.message.id === id && item.message.role === role);
  const item = items[index];
  if (!item) {
    return [...items, { turnId: event.turnId, message: { id, role, text: event.text } }];
  }
  const next = [...items];
  next[index] = {
    ...item,
    message: {
      ...item.message,
      text: (item.message as { text: string }).text + event.text,
    } as ChatMessage,
  };
  return next;
}

/** A tool call starts as a row that its result fills in. */
export function addLiveToolCall(
  items: LiveItems,
  event: Extract<ConversationEvent, { type: 'tool_call' }>
): LiveItems {
  return [
    ...items,
    {
      turnId: event.turnId,
      message: {
        id: event.toolCallId,
        role: 'tool',
        toolCallId: event.toolCallId,
        name: event.name,
      },
    },
  ];
}

/** A tool result fills in its call's row. */
export function applyLiveToolResult(
  items: LiveItems,
  event: Extract<ConversationEvent, { type: 'tool_result' }>
): LiveItems {
  return items.map((item) =>
    item.message.role === 'tool' && item.message.toolCallId === event.toolCallId
      ? {
          ...item,
          message: {
            ...item.message,
            args: event.args ?? item.message.args,
            result: event.result,
            isError: event.isError,
            display: event.display,
            task: event.task,
          },
        }
      : item
  );
}

/**
 * Replaces a turn's streamed items with the persisted rows once history shows them. A
 * streamed answer or reasoning stays until its row is persisted, because the provider can
 * acknowledge completion before history exposes the final rows.
 */
export function settleTurnLive(items: LiveItems, turnId: string, rows: ChatMessage[]): LiveItems {
  const persisted = new Map(rows.map((row) => [row.id, row]));
  return items.filter((item) => {
    if (historyCoversMessage(persisted.get(item.message.id), item.message)) return false;
    if (item.turnId !== turnId) return true;
    return item.message.role === 'assistant' || item.message.role === 'reasoning';
  });
}
