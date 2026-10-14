import type { ConversationSummary } from '../../chat-types';

export interface ConversationSummarySource {
  id: string;
  summary?: string | null;
  last_message_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

/** Project provider conversation fields into the public summary shape. */
export function projectConversationSummary(
  conversation: ConversationSummarySource,
  unread: number
): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.summary?.trim() || 'New chat',
    updatedAt:
      conversation.last_message_at ?? conversation.updated_at ?? conversation.created_at ?? null,
    unread,
  };
}
