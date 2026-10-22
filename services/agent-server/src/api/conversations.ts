import { AppError, NotFoundError } from '@artemis/core';
import { eventStream } from '@artemis/http';
import { Hono } from 'hono';
import type { ChatAttachment, TextEffort } from '@artemis/contracts/chat-types';
import type { ApiDependencies } from './app.ts';
import {
  noContent,
  optionalBody,
  pageResponse,
  parseLimit,
  requireBody,
  requireString,
} from './http.ts';

const EFFORTS: readonly TextEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_TEXT = 100_000;
const MAX_ATTACHMENTS = 20;

/** Conversation, turn, task, message and read routes (architecture.md#13). */
export function conversationRoutes(deps: ApiDependencies): Hono {
  const api = new Hono();

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
    const conversation = await deps.conversations.rewind(c.req.param('id'), c.req.param('messageId'));
    return Response.json({ conversation });
  });

  api.post('/conversations/:id/turns', async (c) => {
    const id = c.req.param('id');
    await deps.conversations.require(id);
    const body = await requireBody(c.req.raw);
    const text = requireString(body, 'text', MAX_TEXT, 0);
    const attachments = optionalArray<ChatAttachment>(body, 'attachments', MAX_ATTACHMENTS);
    if (text.trim() === '' && attachments.length === 0) {
      throw new AppError('invalid_field', 'text or attachments is required', 400);
    }
    const effort = body.effort === undefined ? undefined : requireEffort(body.effort);
    const clientMessageId =
      body.clientMessageId === undefined ? undefined : requireString(body, 'clientMessageId', 200);
    const worker = await deps.supervisor.mainAgent(id);
    const handle = worker.submit({
      kind: 'user',
      modality: 'text',
      mode: 'text',
      text,
      ...(effort ? { effort } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return Response.json({ accepted: true, turnId: handle.turnId }, { status: 202 });
  });

  api.post('/conversations/:id/cancel', (c) => {
    const cancelled = deps.supervisor.peekMainAgent(c.req.param('id'))?.cancel() ?? false;
    return Response.json({ cancelled });
  });

  api.post('/conversations/:id/warm', async (c) => {
    const id = c.req.param('id');
    await deps.conversations.require(id);
    await optionalBody(c.req.raw);
    await deps.supervisor.mainAgent(id);
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
    const updateIds = optionalArray<string>(body, 'updateIds', 500);
    if (updateIds.some((item) => typeof item !== 'string' || item.length > 200)) {
      throw new AppError('invalid_field', 'updateIds must be strings', 400);
    }
    return Response.json({ read: await deps.delivery.markRead(id, updateIds) });
  });

  return api;
}

function optionalArray<T>(body: Record<string, unknown>, field: string, max: number): T[] {
  const value = body[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new AppError('invalid_field', `${field} must be a list of at most ${max} entries`, 400);
  }
  return value as T[];
}

function requireEffort(value: unknown): TextEffort {
  if (typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)) return value as TextEffort;
  throw new AppError('invalid_field', `effort must be one of ${EFFORTS.join(', ')}`, 400);
}
