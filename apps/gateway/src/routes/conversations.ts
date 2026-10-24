import {
  type MessageDeleteResponse,
  conversationPath,
  taskPath,
} from '@artemis/contracts/agent-server';
import {
  type ChatAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_TURN_ATTACHMENTS,
  MAX_TURN_TEXT_LENGTH,
  TEXT_EFFORTS,
  type TextEffort,
} from '@artemis/contracts/chat-types';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AgentServerClient } from '../agent-server/client.ts';
import {
  AttachmentUnavailableError,
  InvalidAttachmentError,
} from '../attachments/attachment-policy.ts';
import type { AttachmentStore } from '../attachments/attachment-store.ts';
import { PROXY_BODY_LIMIT, errorResponse, jsonObject, routeError, withQuery } from '../http.ts';

/**
 * The chat API. Conversations, messages, tasks and live events belong to the
 * agent-server; this router relays them and keeps the gateway's upload
 * references in step with the conversations that use the uploads. Once the
 * agent-server has accepted a change, a bookkeeping failure is logged and never
 * answered as a failure of that change.
 */
export function createConversationRoutes(agent: AgentServerClient, store: AttachmentStore): Hono {
  const conversations = new Hono();
  conversations.onError(routeError);
  conversations.use('*', bodyLimit({ maxSize: PROXY_BODY_LIMIT }));

  conversations.get('/', (c) => agent.relay(c.req.raw, withQuery(c, '/v1/conversations')));
  conversations.post('/', (c) => agent.relay(c.req.raw, '/v1/conversations'));
  // Server-sent events about the conversation list (unread counts).
  conversations.get('/events', (c) => agent.relay(c.req.raw, '/v1/conversations/events'));
  conversations.get('/:id', (c) => agent.relay(c.req.raw, conversationPath(c.req.param('id'))));
  conversations.patch('/:id', (c) => agent.relay(c.req.raw, conversationPath(c.req.param('id'))));

  conversations.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const response = await agent.relay(c.req.raw, conversationPath(id));
    if (response.ok) await store.conversations.release(id).catch(logBookkeeping(id));
    return response;
  });

  conversations.get('/:id/events', (c) =>
    agent.relay(c.req.raw, `${conversationPath(c.req.param('id'))}/events`)
  );
  conversations.get('/:id/messages', (c) =>
    agent.relay(c.req.raw, withQuery(c, `${conversationPath(c.req.param('id'))}/messages`))
  );
  conversations.get('/:id/context-usage', (c) =>
    agent.relay(c.req.raw, `${conversationPath(c.req.param('id'))}/context-usage`)
  );
  conversations.post('/:id/cancel', (c) =>
    agent.relay(c.req.raw, `${conversationPath(c.req.param('id'))}/cancel`)
  );
  conversations.post('/:id/read', (c) =>
    agent.relay(c.req.raw, `${conversationPath(c.req.param('id'))}/read`)
  );
  conversations.get('/:id/tasks', (c) =>
    agent.relay(c.req.raw, `${conversationPath(c.req.param('id'))}/tasks`)
  );
  conversations.get('/:id/tasks/:taskId', (c) =>
    agent.relay(c.req.raw, taskPath(c.req.param('id'), c.req.param('taskId')))
  );
  conversations.post('/:id/tasks/:taskId/cancel', (c) =>
    agent.relay(c.req.raw, `${taskPath(c.req.param('id'), c.req.param('taskId'))}/cancel`)
  );

  /**
   * Send a text message, with optional attachments (uploaded first to
   * /api/attachments). The turn runs in the background; its output reaches the
   * browser through the conversation event stream. The shape is checked here;
   * the agent-server validates the turn and is the authority on its limits.
   */
  conversations.post('/:id/messages', async (c) => {
    const id = c.req.param('id');
    const body = await jsonObject(c.req.raw);
    if (!body) return errorResponse('Body must be a JSON object', 400);
    const text = body.text === undefined ? '' : body.text;
    const effort = body.effort;
    const attachments = body.attachments === undefined ? [] : body.attachments;
    const clientMessageId = body.clientMessageId;
    if (typeof text !== 'string' || text.length > MAX_TURN_TEXT_LENGTH)
      return errorResponse(
        `text must be a string of at most ${MAX_TURN_TEXT_LENGTH} characters`,
        400
      );
    if (
      effort !== undefined &&
      (typeof effort !== 'string' || !(TEXT_EFFORTS as readonly string[]).includes(effort))
    ) {
      return errorResponse(`effort must be one of ${TEXT_EFFORTS.join(', ')}`, 400);
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
              file.size > MAX_ATTACHMENT_BYTES))
        );
      })
    )
      return errorResponse('attachments must be a list of valid attachment objects', 400);
    if (attachments.length > MAX_TURN_ATTACHMENTS) {
      return errorResponse(`At most ${MAX_TURN_ATTACHMENTS} attachments per message`, 400);
    }
    if (!text.trim() && attachments.length === 0) return errorResponse('text is required', 400);
    let resolved: ChatAttachment[];
    try {
      resolved = await store.resolve(attachments as ChatAttachment[]);
    } catch (error) {
      return error instanceof InvalidAttachmentError
        ? errorResponse(error.message, 400)
        : errorResponse(error);
    }
    // The uploads are reserved before the turn is relayed, so an accepted turn never names a removed upload.
    let release: () => Promise<void>;
    try {
      release = await store.conversations.reserve(
        id,
        resolved.map((a) => a.path)
      );
    } catch (error) {
      return error instanceof AttachmentUnavailableError
        ? errorResponse(error.message, 409)
        : errorResponse(error);
    }
    let response: Response;
    try {
      response = await agent.relay(
        c.req.raw,
        `${conversationPath(id)}/turns`,
        JSON.stringify({
          text: text.trim(),
          attachments: resolved,
          ...(effort !== undefined ? { effort: effort as TextEffort } : {}),
          ...(typeof clientMessageId === 'string' ? { clientMessageId } : {}),
        })
      );
    } catch (error) {
      await release().catch(logBookkeeping(id));
      throw error;
    }
    // Only an accepted turn keeps its uploads; a refused or unknown conversation must not pin them.
    if (response.status !== 202) await release().catch(logBookkeeping(id));
    return response;
  });

  /**
   * Delete a user message and everything after it, in place. The conversation
   * keeps its id; its uploads are re-referenced from the attachments the
   * agent-server reports as remaining.
   */
  conversations.delete('/:id/messages/:messageId', async (c) => {
    const id = c.req.param('id');
    const messageId = c.req.param('messageId');
    if (messageId.length > 200) return errorResponse('Invalid message id', 400);
    const response = await agent.relay(
      c.req.raw,
      `${conversationPath(id)}/messages/${encodeURIComponent(messageId)}`
    );
    if (!response.ok) return response;
    // The body is read inside the protecting try: a failure here is bookkeeping, never a failed delete.
    let payload = '';
    try {
      payload = await response.text();
      const { attachments } = JSON.parse(payload) as MessageDeleteResponse;
      if (!Array.isArray(attachments)) throw new Error('agent-server sent no attachment list');
      await store.conversations.replace(id, attachments);
    } catch (error) {
      logBookkeeping(id)(error);
    }
    // The body is re-encoded here (it may be empty after a failed read), so its length header is dropped.
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(payload, { status: response.status, headers });
  });

  return conversations;
}

/** The message of a reference update that failed after the agent-server accepted its change. */
function logBookkeeping(conversationId: string): (error: unknown) => void {
  return (error) =>
    console.error(
      `[attachments] reference update failed for conversation ${conversationId}`,
      error
    );
}
