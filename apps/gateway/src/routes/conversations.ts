import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AgentServerClient } from '../agent-server/client';
import type { ChatAttachment, TextEffort } from '../chat-types';
import {
  addAttachmentReferences,
  releaseAttachmentReferences,
  setAttachmentReferences,
} from '../assistant/filesystem/attachment-retention';
import { resolveAttachments } from '../assistant/filesystem/workspace-adapter';
import { errorResponse, jsonObject, PROXY_BODY_LIMIT, routeError, withQuery } from '../http';

const MAX_ATTACHMENTS = 10;
const TEXT_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The chat API. Conversations, messages, tasks and live events belong to the
 * agent-server; this router relays them and keeps the gateway's upload
 * references in step with the conversations that use the uploads.
 */
export function createConversationRoutes(agent: AgentServerClient): Hono {
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
    if (response.ok) {
      await releaseAttachmentReferences(id).catch((error) => {
        console.error('[conversations] could not release attachment references:', error);
      });
    }
    return response;
  });

  conversations.get('/:id/events', (c) => agent.relay(c.req.raw, `${conversationPath(c.req.param('id'))}/events`));
  conversations.get('/:id/messages', (c) =>
    agent.relay(c.req.raw, withQuery(c, `${conversationPath(c.req.param('id'))}/messages`))
  );
  conversations.get('/:id/context-usage', (c) =>
    agent.relay(c.req.raw, `${conversationPath(c.req.param('id'))}/context-usage`)
  );
  conversations.post('/:id/cancel', (c) => agent.relay(c.req.raw, `${conversationPath(c.req.param('id'))}/cancel`));
  conversations.post('/:id/read', (c) => agent.relay(c.req.raw, `${conversationPath(c.req.param('id'))}/read`));
  conversations.get('/:id/tasks', (c) => agent.relay(c.req.raw, `${conversationPath(c.req.param('id'))}/tasks`));
  conversations.get('/:id/tasks/:taskId', (c) =>
    agent.relay(c.req.raw, taskPath(c.req.param('id'), c.req.param('taskId')))
  );
  conversations.post('/:id/tasks/:taskId/cancel', (c) =>
    agent.relay(c.req.raw, `${taskPath(c.req.param('id'), c.req.param('taskId'))}/cancel`)
  );

  /**
   * Send a text message, with optional attachments (uploaded first to
   * /api/attachments). The turn runs in the background; its output reaches the
   * browser through the conversation event stream.
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
    if (effort !== undefined && !TEXT_EFFORTS.includes(String(effort))) {
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
              file.size > 100_000_000))
        );
      })
    )
      return errorResponse('attachments must be a list of valid attachment objects', 400);
    if (attachments.length > MAX_ATTACHMENTS) {
      return errorResponse(`At most ${MAX_ATTACHMENTS} attachments per message`, 400);
    }
    if (!text.trim() && attachments.length === 0) return errorResponse('text is required', 400);
    let resolved: ChatAttachment[];
    try {
      resolved = await resolveAttachments(attachments as ChatAttachment[]);
    } catch (error) {
      return errorResponse(error, 400);
    }
    const response = await agent.relay(
      c.req.raw,
      `${conversationPath(id)}/turns`,
      JSON.stringify({
        text: text.trim(),
        attachments: resolved,
        ...(effort !== undefined ? { effort: effort as TextEffort } : {}),
        ...(typeof clientMessageId === 'string' ? { clientMessageId } : {}),
      })
    );
    // Only an accepted turn keeps its uploads; a refused or unknown conversation must not pin them.
    if (response.status === 202) {
      await addAttachmentReferences(id, resolved).catch((error) => {
        console.error('[conversations] could not persist attachment references:', error);
      });
    }
    return response;
  });

  /**
   * Delete a user message and everything after it, in place. The conversation
   * keeps its id; its uploads are re-referenced from the messages that remain.
   */
  conversations.delete('/:id/messages/:messageId', async (c) => {
    const id = c.req.param('id');
    const messageId = c.req.param('messageId');
    if (messageId.length > 200) return errorResponse('Invalid message id', 400);
    const response = await agent.relay(c.req.raw, `${conversationPath(id)}/messages/${encodeURIComponent(messageId)}`);
    if (response.ok) {
      await setAttachmentReferences(id, await attachmentsInConversation(agent, id)).catch((error) => {
        console.error('[conversations] could not refresh attachment references:', error);
      });
    }
    return response;
  });

  return conversations;
}

function conversationPath(id: string): string {
  return `/v1/conversations/${encodeURIComponent(id)}`;
}

function taskPath(id: string, taskId: string): string {
  return `${conversationPath(id)}/tasks/${encodeURIComponent(taskId)}`;
}

/** Every upload any message of the conversation still shows. */
async function attachmentsInConversation(agent: AgentServerClient, id: string): Promise<ChatAttachment[]> {
  const attachments = new Map<string, ChatAttachment>();
  let before: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const result = await agent.messagesPage(id, { limit: 100, ...(before ? { before } : {}) });
    for (const message of result.messages) {
      if (message.role !== 'user') continue;
      for (const attachment of message.attachments ?? []) attachments.set(attachment.path, attachment);
    }
    if (!result.nextCursor) return [...attachments.values()];
    before = result.nextCursor;
  }
  throw new Error('Conversation history exceeded the attachment reference scan limit');
}
