import { AppError, NotFoundError } from '@artemis/core';
import { eventStream } from '@artemis/http';
import { Hono } from 'hono';
import { MAX_TURN_TEXT_LENGTH } from '@artemis/contracts/chat-types';
import type { ConversationService } from '../conversations/service.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { BackgroundDeliveryService } from '../tasks/delivery.ts';
import type { TaskPort } from '../tools/task-port.ts';
import { noContent, pageResponse } from './http.ts';
import {
  MAX_UPDATE_IDS,
  invalidField,
  isUuid,
  optionalBody,
  optionalList,
  parseAttachments,
  parseLimit,
  requireBody,
  requireEffort,
  requireString,
  requireUuidParam,
} from './validation.ts';

/** The ports the conversation routes use. */
export interface ConversationRouteDeps {
  conversations: ConversationService;
  tasks: TaskPort;
  delivery: Pick<BackgroundDeliveryService, 'markRead'>;
  events: ConversationEventHub;
}

/** Conversation, turn, task, message and read routes (docs/architecture.md, "How the services talk"). */
export function conversationRoutes(deps: ConversationRouteDeps): Hono {
  const api = new Hono();

  // `events` is the reserved list-stream route; every other conversation id must be a uuid.
  const requireConversationId = requireUuidParam('id', 'Conversation', ['events']);
  api.use('/conversations/:id', requireConversationId);
  api.use('/conversations/:id/*', requireConversationId);

  api.get('/conversations', async (c) => {
    const page = await deps.conversations.list({
      limit: parseLimit(c.req.query('limit'), 50, 200),
      ...(c.req.query('after') ? { after: c.req.query('after') } : {}),
    });
    return pageResponse(page.items, page.nextCursor);
  });

  api.post('/conversations', async (c) => {
    const body = await optionalBody(c.req.raw);
    const title = body.title === undefined ? undefined : requireString(body, 'title', 200);
    return Response.json(await deps.conversations.create({ ...(title ? { title } : {}) }), { status: 201 });
  });

  // Conversation list channel: SSE (`ConversationListEvent`).
  api.get('/conversations/events', (c) =>
    eventStream(c.req.raw, (send) => deps.events.subscribeList((event) => send(event)))
  );

  api.get('/conversations/:id', async (c) => Response.json(await deps.conversations.require(c.req.param('id'))));

  api.patch('/conversations/:id', async (c) => {
    const id = c.req.param('id');
    const body = await requireBody(c.req.raw);
    const title = requireString(body, 'title', 200);
    return Response.json(await deps.conversations.rename(id, title));
  });

  api.delete('/conversations/:id', async (c) => {
    await deps.conversations.archive(c.req.param('id'));
    return noContent();
  });

  // Per-conversation channel: SSE (`ConversationEvent`), snapshot first.
  api.get('/conversations/:id/events', async (c) => {
    const id = c.req.param('id');
    await deps.conversations.require(id);
    return eventStream(c.req.raw, (send) => deps.events.subscribe(id, (event) => send(event)));
  });

  api.get('/conversations/:id/messages', async (c) => {
    const id = c.req.param('id');
    const page = await deps.conversations.messages(id, {
      limit: parseLimit(c.req.query('limit'), 50, 200),
      ...(c.req.query('before') ? { before: c.req.query('before') } : {}),
    });
    return pageResponse(page.rows, page.nextCursor);
  });

  api.delete('/conversations/:id/messages/:messageId', async (c) => {
    const response = await deps.conversations.rewind(c.req.param('id'), c.req.param('messageId'));
    return Response.json(response);
  });

  api.post('/conversations/:id/turns', async (c) => {
    const id = c.req.param('id');
    await deps.conversations.require(id);
    const body = await requireBody(c.req.raw);
    const text = requireString(body, 'text', MAX_TURN_TEXT_LENGTH, 0);
    const attachments = parseAttachments(body.attachments);
    if (text.trim() === '' && attachments.length === 0) {
      throw new AppError('invalid_field', 'text or attachments is required', 400);
    }
    const effort = body.effort === undefined ? undefined : requireEffort(body.effort);
    const clientMessageId =
      body.clientMessageId === undefined ? undefined : requireString(body, 'clientMessageId', 200);
    const handle = await deps.conversations.submitTurn(id, {
      text,
      ...(effort ? { effort } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return Response.json({ accepted: true, turnId: handle.turnId }, { status: 202 });
  });

  api.post('/conversations/:id/cancel', (c) =>
    Response.json({ cancelled: deps.conversations.cancelTurn(c.req.param('id')) })
  );

  api.post('/conversations/:id/warm', async (c) => {
    const id = c.req.param('id');
    await deps.conversations.require(id);
    await optionalBody(c.req.raw);
    await deps.conversations.warm(id);
    return noContent();
  });

  api.get('/conversations/:id/context-usage', async (c) =>
    Response.json(await deps.conversations.contextUsage(c.req.param('id')))
  );

  api.get('/conversations/:id/tasks', async (c) => {
    const id = c.req.param('id');
    await deps.conversations.require(id);
    return Response.json(await deps.tasks.list(id));
  });

  api.get('/conversations/:id/tasks/:taskId', async (c) => {
    const { id, taskId } = c.req.param();
    const task = await deps.tasks.get(id, taskId);
    if (!task) throw new NotFoundError('Task');
    return Response.json(task);
  });

  api.post('/conversations/:id/tasks/:taskId/cancel', async (c) => {
    const { id, taskId } = c.req.param();
    return Response.json({ cancelled: await deps.tasks.stop(id, taskId) });
  });

  api.post('/conversations/:id/read', async (c) => {
    const id = c.req.param('id');
    const body = await requireBody(c.req.raw);
    const entries = optionalList(body, 'updateIds', MAX_UPDATE_IDS);
    const updateIds = entries.filter((item): item is string => typeof item === 'string' && isUuid(item));
    if (updateIds.length !== entries.length) throw invalidField('updateIds must be uuids');
    return Response.json({ read: await deps.delivery.markRead(id, updateIds) });
  });

  return api;
}
