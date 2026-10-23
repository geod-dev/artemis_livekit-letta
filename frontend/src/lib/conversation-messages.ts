import type { ChatMessage } from '@shared/chat-types';
import type { LiveConversationItem } from './conversation-state.ts';

/** History can lag the stream even after the provider acknowledges a turn. */
export function historyCoversMessage(
  persisted: ChatMessage | undefined,
  live: ChatMessage
): boolean {
  if (!persisted) return false;
  if ((live.role === 'assistant' || live.role === 'reasoning') && live.role === persisted.role) {
    return persisted.text.length >= live.text.length;
  }
  return true;
}

/** Keep history's order and metadata while retaining more complete live text. */
export function mergeConversationMessages(
  history: ChatMessage[],
  streamed: LiveConversationItem[],
  pending: Extract<ChatMessage, { role: 'user' }> | null
): ChatMessage[] {
  // A replayed live message (e.g. after a reconnect) must show once: keep its first copy.
  const seen = new Set<string>();
  const live = streamed.filter(({ message }) => {
    const key = `${message.role}:${message.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const liveById = new Map(live.map(({ message }) => [message.id, message]));
  const persisted = history.map((row) => {
    const streamed = liveById.get(row.id);
    return streamed &&
      !historyCoversMessage(row, streamed) &&
      (streamed.role === 'assistant' || streamed.role === 'reasoning')
      ? ({ ...row, text: streamed.text } as ChatMessage)
      : row;
  });
  const ids = new Set(history.map((message) => message.id));
  const tools = new Set(
    history.flatMap((message) => (message.role === 'tool' ? [message.toolCallId] : []))
  );
  const clients = new Set(
    history.flatMap((message) =>
      message.role === 'user' && message.clientMessageId ? [message.clientMessageId] : []
    )
  );
  const updates = new Set(
    history.flatMap((message) =>
      message.role === 'event' && message.updateId ? [message.updateId] : []
    )
  );
  const remaining = live.filter(
    ({ message }) =>
      !ids.has(message.id) &&
      !(message.role === 'tool' && tools.has(message.toolCallId)) &&
      !(
        message.role === 'user' &&
        message.clientMessageId &&
        clients.has(message.clientMessageId)
      ) &&
      !(message.role === 'event' && message.updateId && updates.has(message.updateId))
  );
  return [...persisted, ...remaining.map(({ message }) => message), ...(pending ? [pending] : [])];
}
