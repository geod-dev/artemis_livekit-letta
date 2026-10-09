import { EventEmitter } from 'node:events';
import type { ConversationEvent, ConversationListEvent } from '../chat-types';

/**
 * In-process pub/sub for live conversation events. Text turns, voice turns and
 * background task results all publish here, so any open chat view renders them
 * the same way.
 */
const hub = new EventEmitter().setMaxListeners(0);

/** Channel for changes that concern the conversation list (e.g. unread counts). */
const LIST = Symbol.for('conversation-list');

export function publish(conversationId: string, event: ConversationEvent): void {
  hub.emit(conversationId, event);
}

export function subscribe(
  conversationId: string,
  listener: (event: ConversationEvent) => void
): () => void {
  hub.on(conversationId, listener);
  return () => hub.off(conversationId, listener);
}

export function publishList(event: ConversationListEvent): void {
  hub.emit(LIST, event);
}

export function subscribeList(listener: (event: ConversationListEvent) => void): () => void {
  hub.on(LIST, listener);
  return () => hub.off(LIST, listener);
}
