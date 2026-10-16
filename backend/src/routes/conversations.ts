import { Hono } from 'hono';
import {
  listTasks,
  markRead,
  retireConversation,
  taskStopRequested,
  taskStopped,
} from '../assistant/background/service.ts';
import { activeCall, endCall } from '../assistant/calls/state.ts';
import {
  clearConversationEvents,
  subscribeList,
  subscribeWithSnapshot,
} from '../assistant/conversations/events.ts';
import { RecoverableForkArchiveError } from '../assistant/conversations/lifecycle.ts';
import {
  archiveConversation,
  conversationHasAttachments,
  createConversation,
  deleteFromMessage,
  listConversations,
  listMessagesPage,
  renameConversation,
  requireConversation,
} from '../assistant/conversations/service.ts';
import {
  addAttachmentReferences,
  setAttachmentReferences,
} from '../assistant/filesystem/attachment-retention';
import { resolveAttachments } from '../assistant/filesystem/workspace-adapter.ts';
import { conversationRuntime, withConversationMutation } from '../assistant/runtime';
import type { ChatAttachment, ConversationTask, TextEffort } from '../chat-types';
import { errorResponse, eventStream, jsonObject } from '../http';

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
  try {
    return Response.json(await requireConversation(c.req.param('id')));
  } catch (error) {
    return errorResponse(error);
  }
});

conversations.patch('/:id', async (c) => {
  try {
    const body = await jsonObject(c.req.raw);
    const title = body?.title;
    if (typeof title !== 'string' || !title.trim() || title.length > 200)
      return errorResponse('title must be a non-empty string of at most 200 characters', 400);
    return Response.json(await renameConversation(c.req.param('id'), title.trim()));
  } catch (error) {
    return errorResponse(error);
  }
});

conversations.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await withConversationMutation(id, async () => {
      await archiveConversation(id);
      // Letta archives keep their history, so its attachment owner remains live.
      await retireConversation(id);
      endCall(id);
      clearConversationEvents(id);
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
});

/** Server-sent events for everything happening in one conversation. */
conversations.get('/:id/events', async (c) => {
  try {
    const id = c.req.param('id');
    await requireConversation(id);
    return eventStream(c.req.raw, (send) => subscribeWithSnapshot(id, send));
  } catch (error) {
    return errorResponse(error);
  }
});

conversations.get('/:id/messages', async (c) => {
  try {
    const before = c.req.query('before');
    if (before !== undefined && (!before || before.length > 200))
      return errorResponse('before cursor is invalid', 400);
    const requested = Number(c.req.query('limit') ?? 100);
    if (!Number.isInteger(requested) || requested < 1 || requested > 100)
      return errorResponse('limit must be an integer from 1 to 100', 400);
    const page = await listMessagesPage(c.req.param('id'), {
      ...(before ? { before } : {}),
      limit: requested,
    });
    return Response.json(page.messages, {
      headers: page.nextCursor ? { 'X-Next-Cursor': page.nextCursor } : {},
    });
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
  const body = await jsonObject(c.req.raw);
  if (!body) return errorResponse('Body must be a JSON object', 400);
  const text = body.text === undefined ? '' : body.text;
  const effort = body.effort;
  const attachments = body.attachments === undefined ? [] : body.attachments;
  const clientMessageId = body.clientMessageId;
  if (typeof text !== 'string' || text.length > 100_000)
    return errorResponse('text must be a string of at most 100000 characters', 400);
  if (effort !== undefined && !['fast', 'low', 'medium', 'high'].includes(String(effort))) {
    return errorResponse('effort must be fast, low, medium, or high', 400);
  }
  if (
    clientMessageId !== undefined &&
    (typeof clientMessageId !== 'string' ||
      clientMessageId.length < 1 ||
      clientMessageId.length > 200)
  )
    return errorResponse('clientMessageId must be a string of at most 200 characters', 400);
  if (
    !Array.isArray(attachments) ||
    attachments.some((a) => {
      if (!a || typeof a !== 'object' || Array.isArray(a)) return true;
      const file = a as Record<string, unknown>;
      return (
        typeof file.path !== 'string' ||
        file.path.length > 500 ||
        typeof file.name !== 'string' ||
        file.name.length > 255 ||
        !['image', 'file'].includes(String(file.kind)) ||
        (file.mimeType !== undefined &&
          (typeof file.mimeType !== 'string' || file.mimeType.length > 200)) ||
        (file.size !== undefined &&
          (typeof file.size !== 'number' ||
            !Number.isSafeInteger(file.size) ||
            file.size < 0 ||
            file.size > 100_000_000))
      );
    })
  )
    return errorResponse('attachments must be a list of valid attachment objects', 400);
  if (attachments.length > MAX_ATTACHMENTS) {
    return errorResponse(`At most ${MAX_ATTACHMENTS} attachments per message`, 400);
  }
  if (!text.trim() && attachments.length === 0) return errorResponse('text is required', 400);
  try {
    await requireConversation(id);
  } catch (error) {
    return errorResponse(error);
  }
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
  const admitted = conversationRuntime(id).tryRun({
    text: text.trim(),
    modality: 'text',
    effort: (effort as TextEffort | undefined) ?? 'medium',
    ...(typeof clientMessageId === 'string' ? { clientMessageId } : {}),
    ...resolved,
  });
  if (!admitted) return errorResponse('Conversation is busy; retry the message', 429);
  await addAttachmentReferences(id, resolved.attachments).catch((error) => {
    console.error('[conversations] could not persist attachment references:', error);
  });
  return Response.json({ accepted: true }, { status: 202 });
});

/**
 * Stop the turn being run (the user pressed stop). It ends like any other
 * turn, with a `turn_end` event whose error is `aborted`.
 */
conversations.post('/:id/cancel', async (c) => {
  try {
    await requireConversation(c.req.param('id'));
    return Response.json({ cancelled: conversationRuntime(c.req.param('id')).cancel() });
  } catch (error) {
    return errorResponse(error);
  }
});

conversations.get('/:id/tasks', async (c) => {
  try {
    const id = c.req.param('id');
    await requireConversation(id);
    let native: ConversationTask[] = [];
    try {
      native = (await conversationRuntime(id).taskControl()) as ConversationTask[];
    } catch (error) {
      console.warn(`[api] native task inventory unavailable for ${id}:`, error);
    }
    return Response.json(listTasks(id, native));
  } catch (error) {
    return errorResponse(error);
  }
});

conversations.post('/:id/tasks/:taskId/cancel', async (c) => {
  try {
    const { id, taskId } = c.req.param();
    if (!taskId || taskId.length > 200) return errorResponse('Invalid task id', 400);
    await requireConversation(id);
    const runtime = conversationRuntime(id);
    const native = (await runtime.taskControl()) as ConversationTask[];
    const task = native.find((entry) => entry.id === taskId);
    if (!task) return errorResponse('Task is no longer available in this conversation', 404);
    if (task.status !== 'running') return Response.json({ cancelled: false });
    await taskStopRequested(id, taskId);
    const result = (await runtime.taskControl(taskId)) as { killed: boolean };
    if (!result.killed)
      return errorResponse('The task could not be stopped. Refresh tasks and try again.', 409);
    await taskStopped(id, task);
    return Response.json({ cancelled: true });
  } catch (error) {
    return errorResponse(error);
  }
});

/**
 * Delete a user message and everything after it. The history moves to a new
 * conversation (see deleteFromMessage); the response names it, or is
 * `{ conversation: null }` when the whole conversation was deleted.
 */
conversations.delete('/:id/messages/:messageId', async (c) => {
  try {
    const { id, messageId } = c.req.param();
    await requireConversation(id);
    if (messageId.length > 200) return errorResponse('Invalid message id', 400);
    const conversation = await withConversationMutation(id, async () => {
      const fork = await deleteFromMessage(id, messageId);
      if (fork) {
        const attachments = await attachmentsInConversation(fork.id);
        await setAttachmentReferences(fork.id, attachments);
      }
      // The original is archived by deleteFromMessage and still has its full
      // canonical history; the fork gets a separate owner for its retained part.
      endCall(id);
      clearConversationEvents(id);
      return fork;
    });
    return Response.json({ conversation });
  } catch (error) {
    if (error instanceof RecoverableForkArchiveError) {
      return Response.json(
        {
          conversation: error.conversation,
          recoveryStage: error.stage,
          sourceArchived: error.stage === 'routing' ? false : null,
          recoverable: true,
        },
        { status: 202 }
      );
    }
    return errorResponse(error);
  }
});

async function attachmentsInConversation(id: string): Promise<ChatAttachment[]> {
  const attachments = new Map<string, ChatAttachment>();
  let before: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const result = await listMessagesPage(id, { limit: 100, ...(before ? { before } : {}) });
    for (const message of result.messages) {
      if (message.role !== 'user') continue;
      for (const attachment of message.attachments ?? [])
        attachments.set(attachment.path, attachment);
    }
    if (!result.nextCursor) return [...attachments.values()];
    before = result.nextCursor;
  }
  throw new Error('Conversation history exceeded the attachment reference scan limit');
}

/** The browser showed these background updates and their responses on screen. */
conversations.post('/:id/read', async (c) => {
  const body = await jsonObject(c.req.raw);
  const updateIds = body?.updateIds;
  if (
    !body ||
    !Array.isArray(updateIds) ||
    updateIds.length > 300 ||
    !updateIds.every((u) => typeof u === 'string' && u.length <= 200)
  ) {
    return errorResponse('updateIds must be a list of update ids', 400);
  }
  try {
    await requireConversation(c.req.param('id'));
    await markRead(c.req.param('id'), updateIds);
    return Response.json({ read: updateIds.length });
  } catch (error) {
    return errorResponse(error);
  }
});
