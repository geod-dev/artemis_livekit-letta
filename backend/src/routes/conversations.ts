import { Hono } from 'hono';
import { markRead } from '../assistant/background';
import { activeCall } from '../assistant/calls';
import {
  archiveConversation,
  conversationHasAttachments,
  createConversation,
  deleteFromMessage,
  getConversation,
  listConversations,
  listMessages,
  renameConversation,
} from '../assistant/conversations';
import { subscribe, subscribeList } from '../assistant/events';
import { closeConversationRuntime, conversationRuntime } from '../assistant/runtime';
import { resolveAttachments } from '../assistant/workspace';
import type { ChatAttachment, TextEffort } from '../chat-types';
import { errorResponse, eventStream } from '../http';

const MAX_ATTACHMENTS = 10;

/** The chat: conversations, their messages and their live events. */
export const conversations = new Hono();

conversations.get('/', async () => {
  try {
    return Response.json(await listConversations());
  } catch (error) {
    return errorResponse(error);
  }
});

conversations.post('/', async () => {
  try {
    return Response.json(await createConversation(), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
});

/** Server-sent events about the conversation list (unread counts). */
conversations.get('/events', (c) => eventStream(c.req.raw, (send) => subscribeList(send)));

conversations.get('/:id', async (c) => {
  const conversation = await getConversation(c.req.param('id')).catch(() => null);
  return conversation ? Response.json(conversation) : errorResponse('Not found', 404);
});

conversations.patch('/:id', async (c) => {
  try {
    const { title } = (await c.req.json()) as { title?: string };
    if (!title?.trim()) return errorResponse('title is required', 400);
    return Response.json(await renameConversation(c.req.param('id'), title.trim()));
  } catch (error) {
    return errorResponse(error);
  }
});

conversations.delete('/:id', async (c) => {
  try {
    await archiveConversation(c.req.param('id'));
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
});

/** Server-sent events for everything happening in one conversation. */
conversations.get('/:id/events', (c) =>
  eventStream(c.req.raw, (send) => subscribe(c.req.param('id'), send))
);

conversations.get('/:id/messages', async (c) => {
  try {
    return Response.json(await listMessages(c.req.param('id')));
  } catch (error) {
    return errorResponse(error);
  }
});

/**
 * Send a text message, with optional attachments (uploaded first to
 * /api/attachments). The turn runs in the background; its output reaches the
 * browser through the conversation event stream, exactly like voice turns and
 * background task results do.
 */
conversations.post('/:id/messages', async (c) => {
  const id = c.req.param('id');
  const {
    text = '',
    effort,
    attachments = [],
  } = (await c.req.json().catch(() => ({}))) as {
    text?: string;
    effort?: TextEffort;
    attachments?: ChatAttachment[];
  };
  if (!text.trim() && attachments.length === 0) return errorResponse('text is required', 400);
  if (effort !== undefined && !['fast', 'low', 'medium', 'high'].includes(effort)) {
    return errorResponse('effort must be fast, low, medium, or high', 400);
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    return errorResponse(`At most ${MAX_ATTACHMENTS} attachments per message`, 400);
  }
  if (!(await getConversation(id))) return errorResponse('Conversation not found', 404);
  // The fast model (Instant, voice calls) reads no images.
  if (attachments.length > 0 && activeCall(id)) {
    return errorResponse('Attachments cannot be sent during a call', 409);
  }
  if (effort === 'fast' && (attachments.length > 0 || (await conversationHasAttachments(id)))) {
    return errorResponse('Instant is not available in conversations with attachments', 400);
  }

  let resolved: Awaited<ReturnType<typeof resolveAttachments>>;
  try {
    resolved = await resolveAttachments(attachments);
  } catch (error) {
    return errorResponse(error, 400);
  }
  void conversationRuntime(id).run({
    text: text.trim(),
    modality: 'text',
    effort: effort ?? 'medium',
    ...resolved,
  });
  return Response.json({ accepted: true }, { status: 202 });
});

/**
 * Stop the turn being run (the user pressed stop). It ends like any other
 * turn, with a `turn_end` event whose error is `aborted`.
 */
conversations.post('/:id/cancel', (c) =>
  Response.json({ cancelled: conversationRuntime(c.req.param('id')).cancel() })
);

/**
 * Delete a user message and everything after it. The history moves to a new
 * conversation (see deleteFromMessage); the response names it, or is
 * `{ conversation: null }` when the whole conversation was deleted.
 */
conversations.delete('/:id/messages/:messageId', async (c) => {
  try {
    const { id, messageId } = c.req.param();
    if (!(await getConversation(id))) return errorResponse('Conversation not found', 404);
    const conversation = await deleteFromMessage(id, messageId);
    closeConversationRuntime(id);
    return Response.json({ conversation });
  } catch (error) {
    return errorResponse(error);
  }
});

/** The browser showed these background updates and their responses on screen. */
conversations.post('/:id/read', async (c) => {
  const { updateIds } = (await c.req.json().catch(() => ({}))) as { updateIds?: unknown };
  if (!Array.isArray(updateIds) || !updateIds.every((u) => typeof u === 'string')) {
    return errorResponse('updateIds must be a list of update ids', 400);
  }
  markRead(c.req.param('id'), updateIds);
  return Response.json({ read: updateIds.length });
});
