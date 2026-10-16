import type { ChatMessage, ConversationSummary } from '../../chat-types';
import { HttpError } from '../../http';
import { retireConversation, unreadCount, withUpdates } from '../background/service.ts';
import { config } from '../config';
import { projectConversationSummary } from './projection.ts';
import { archiveForkWithRouting } from './lifecycle.ts';
import { assistant, letta } from '../letta/agent-client.ts';
import { normalizeHistory } from './messages.ts';
import { collectProviderPages } from './pagination.ts';

/**
 * Conversations are Letta conversations on the one assistant agent. There is no
 * other conversation store: the UI list, text turns and voice turns all read
 * and write the same Letta threads.
 */

type LettaConversation = Awaited<ReturnType<ReturnType<typeof letta>['conversations']['retrieve']>>;
const MAX_PROVIDER_PAGES = 100;

export function toSummary(c: LettaConversation): ConversationSummary {
  return projectConversationSummary(c, unreadCount(c.id));
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const { agentId, defaultConversationId } = await assistant();
  const conversations = await collectProviderPages({
    resource: 'conversation list',
    pageSize: 100,
    maxPages: MAX_PROVIDER_PAGES,
    fetchPage: (after) => letta().conversations.list({
      agentId,
      orderBy: 'lastMessageAt',
      order: 'desc',
      limit: 100,
      ...(after ? { after } : {}),
    }),
    cursorFor: (page) => page.at(-1)?.id,
  });
  return conversations.filter((c) => c.id !== defaultConversationId && !c.archived).map(toSummary);
}

export async function createConversation(): Promise<ConversationSummary> {
  const { agentId } = await assistant();
  // New conversations use the assistant model.
  const conversation = await letta().conversations.create({
    agentId,
    model: config.model.handle,
  });
  return toSummary(conversation);
}

export async function getConversation(id: string): Promise<ConversationSummary | null> {
  const { agentId, defaultConversationId } = await assistant();
  try {
    const conversation = await letta().conversations.retrieve(id);
    const ours = conversation.agent_id === agentId && conversation.id !== defaultConversationId;
    return ours && !conversation.archived ? toSummary(conversation) : null;
  } catch (error) {
    if (statusOf(error) === 404) return null;
    throw error;
  }
}

export async function requireConversation(id: string): Promise<ConversationSummary> {
  const conversation = await getConversation(id);
  if (!conversation) throw new HttpError('Conversation not found', 404);
  return conversation;
}

export async function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  await requireConversation(id);
  const { renameConversationTitle } = await import('./titles.ts');
  return toSummary(await renameConversationTitle(id, title));
}

export async function archiveConversation(id: string): Promise<void> {
  await requireConversation(id);
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
  await requireConversation(id);
  const conversation = await client.conversations.retrieve(id);
  const earlier = await collectProviderPages({
    resource: 'conversation message history',
    pageSize: 100,
    maxPages: MAX_PROVIDER_PAGES,
    initialCursor: messageId,
    fetchPage: async (before) => (await client.conversations.listMessages(id, {
      before,
      order: 'desc',
      limit: 100,
    })).messages,
    cursorFor: (page) => String(page.at(-1)?.id ?? '') || undefined,
  });
  const visibleBefore = normalizeHistory([...earlier].reverse());
  if (visibleBefore.length === 0) {
    await archiveConversation(id);
    await retireConversation(id);
    return null;
  }
  const fork = await client.conversations.fork(id, { messageId: String(earlier[0].id) });
  let titled = fork;
  if (conversation.summary?.trim()) {
    // Summary copying is cosmetic. A failure here must not strand a valid fork
    // or prevent the source from following the normal lifecycle below.
    try { titled = await client.conversations.update(fork.id, { summary: conversation.summary }); }
    catch { titled = fork; }
  }
  // Install durable callback routing before the provider marks the source
  // archived, so a worker callback cannot fall back to native delivery in the
  // interval between the two operations.
  const summary = toSummary(titled);
  await archiveForkWithRouting(
    summary,
    () => retireConversation(id, summary.id),
    () => client.conversations.update(id, { archived: true })
  );
  return summary;
}

export async function listMessages(
  id: string,
  options: { before?: string; limit?: number } = {}
): Promise<ChatMessage[]> {
  return (await listMessagesPage(id, options)).messages;
}

export async function listMessagesPage(
  id: string,
  options: { before?: string; limit?: number } = {}
): Promise<{ messages: ChatMessage[]; nextCursor?: string }> {
  await requireConversation(id);
  const limit = Math.max(1, Math.min(100, options.limit ?? 100));
  const { messages: raw } = await letta().conversations.listMessages(id, {
    order: 'desc',
    limit,
    ...(options.before ? { before: options.before } : {}),
  });
  const nextCursor = raw.length >= limit ? String(raw.at(-1)?.id ?? '') || undefined : undefined;
  return {
    messages: withUpdates(id, normalizeHistory([...raw].reverse())),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const row = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const status = row.status ?? row.statusCode ?? row.response?.status;
  return typeof status === 'number' ? status : undefined;
}
