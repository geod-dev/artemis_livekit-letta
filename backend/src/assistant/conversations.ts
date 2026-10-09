import type { ChatMessage, ConversationSummary } from '../chat-types';
import { unreadCount, withUpdates } from './background';
import { config } from './config';
import { assistant, letta } from './letta';
import { normalizeHistory } from './messages';

/**
 * Conversations are Letta conversations on the one assistant agent. There is no
 * other conversation store: the UI list, text turns and voice turns all read
 * and write the same Letta threads.
 */

type LettaConversation = Awaited<ReturnType<ReturnType<typeof letta>['conversations']['retrieve']>>;

export function toSummary(c: LettaConversation): ConversationSummary {
  return {
    id: c.id,
    title: c.summary?.trim() || 'New chat',
    updatedAt: c.last_message_at ?? c.updated_at ?? c.created_at ?? null,
    unread: unreadCount(c.id),
  };
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const { agentId, defaultConversationId } = await assistant();
  const conversations = await letta().conversations.list({
    agentId,
    orderBy: 'lastMessageAt',
    order: 'desc',
    limit: 100,
  });
  return conversations.filter((c) => c.id !== defaultConversationId && !c.archived).map(toSummary);
}

export async function createConversation(): Promise<ConversationSummary> {
  const { agentId } = await assistant();
  // New conversations start on the text model; voice turns switch it per turn.
  const conversation = await letta().conversations.create({
    agentId,
    model: config.models.smart.handle,
  });
  return toSummary(conversation);
}

export async function getConversation(id: string): Promise<ConversationSummary | null> {
  const { agentId, defaultConversationId } = await assistant();
  try {
    const conversation = await letta().conversations.retrieve(id);
    const ours = conversation.agent_id === agentId && conversation.id !== defaultConversationId;
    return ours && !conversation.archived ? toSummary(conversation) : null;
  } catch {
    return null;
  }
}

export async function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  return toSummary(await letta().conversations.update(id, { summary: title }));
}

export async function archiveConversation(id: string): Promise<void> {
  await letta().conversations.update(id, { archived: true });
}

/**
 * Delete a user message and everything after it. Letta cannot remove messages
 * in place, so the conversation is forked up to the message just before it,
 * keeps its title, and the original is archived (Letta keeps it). Deleting the
 * first message archives the whole conversation.
 *
 * Resolves with the conversation that now holds the history, or null when the
 * conversation was archived.
 */
export async function deleteFromMessage(
  id: string,
  messageId: string
): Promise<ConversationSummary | null> {
  const client = letta();
  const conversation = await client.conversations.retrieve(id);
  const { messages: earlier } = await client.conversations.listMessages(id, {
    before: messageId,
    order: 'desc',
    limit: 300,
  });
  const visibleBefore = normalizeHistory([...earlier].reverse() as never);
  if (visibleBefore.length === 0) {
    await archiveConversation(id);
    return null;
  }
  const fork = await client.conversations.fork(id, { messageId: String(earlier[0].id) });
  const titled = conversation.summary?.trim()
    ? await client.conversations.update(fork.id, { summary: conversation.summary })
    : fork;
  await archiveConversation(id);
  return toSummary(titled);
}

/**
 * Whether the conversation's history holds attachments. Such conversations stay
 * on the smart model: the fast model (Instant, voice calls) reads no images.
 */
export async function conversationHasAttachments(id: string): Promise<boolean> {
  const { messages } = await letta().conversations.listMessages(id, { order: 'desc', limit: 300 });
  return normalizeHistory(messages as never).some(
    (m) => m.role === 'user' && !!m.attachments?.length
  );
}

export async function listMessages(id: string): Promise<ChatMessage[]> {
  const { messages } = await letta().conversations.listMessages(id, { order: 'desc', limit: 300 });
  return withUpdates(id, normalizeHistory([...messages].reverse() as never));
}
