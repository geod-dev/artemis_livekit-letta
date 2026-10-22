import { notImplemented } from '@artemis/core';
import type { ChatMessage, ConversationContextUsage, ConversationSummary } from '@artemis/contracts/chat-types';

/**
 * Conversation CRUD over storage. `create` renders and freezes the system
 * prompt + tool definitions (prompt snapshot). Delete = archive (stop workers,
 * release artifacts). Rewind = soft-delete from a message, in place.
 */
export abstract class ConversationService {
  abstract list(options: { limit: number; after?: string }): Promise<{ items: ConversationSummary[]; nextCursor: string | null }>;
  abstract create(input: { title?: string }): Promise<ConversationSummary>;
  /** Throws `NotFoundError`. */
  abstract require(id: string): Promise<ConversationSummary>;
  abstract rename(id: string, title: string): Promise<ConversationSummary>;
  abstract archive(id: string): Promise<void>;
  abstract rewind(id: string, messageId: string): Promise<ConversationSummary | null>;
  /** UI rows, newest page first (`before` = row cursor), plus `X-Next-Cursor`. */
  abstract messages(id: string, options: { before?: string; limit: number }): Promise<{ rows: ChatMessage[]; nextCursor: string | null }>;
  abstract contextUsage(id: string): Promise<ConversationContextUsage | null>;
}

export function createConversationService(): ConversationService {
  return notImplemented('createConversationService');
}
