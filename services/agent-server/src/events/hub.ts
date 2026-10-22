import { notImplemented } from '@artemis/core';
import type { ConversationEvent, ConversationListEvent } from '@artemis/contracts/chat-types';

/**
 * In-process pub/sub per conversation + the list channel (port of
 * backend/src/assistant/conversations/events.ts): retains in-flight turns and
 * running tasks to send a bounded `snapshot` first on subscribe (<= 4 turns,
 * <= 32 events/turn, <= 128 KB text/turn). Single-instance by design.
 */
export class ConversationEventHub {
  publish(_conversationId: string, _event: ConversationEvent): void {
    notImplemented('ConversationEventHub.publish');
  }

  /** Sends `snapshot` first, then live events; returns unsubscribe. */
  subscribe(_conversationId: string, _listener: (event: ConversationEvent) => void): () => void {
    return notImplemented('ConversationEventHub.subscribe');
  }

  publishList(_event: ConversationListEvent): void {
    notImplemented('ConversationEventHub.publishList');
  }

  subscribeList(_listener: (event: ConversationListEvent) => void): () => void {
    return notImplemented('ConversationEventHub.subscribeList');
  }

  clear(_conversationId: string): void {
    notImplemented('ConversationEventHub.clear');
  }

  close(): void {
    notImplemented('ConversationEventHub.close');
  }
}
