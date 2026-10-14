import { Hono } from 'hono';
import { receiveNotifications, retireConversation, retiredConversationDestination } from '../assistant/background/service.ts';
import { assistant, letta as getLettaClient } from '../assistant/letta/agent-client.ts';
import { errorResponse, HttpError, isLettaServer, jsonObject } from '../http';
import type { ToolAnswer } from '../internal-tools/types';
import { toolHandlers } from '../mcp/native-tools';
import { extractTaskNotifications } from '../assistant/background/task-notifications.ts';
import { requireConversation } from '../assistant/conversations/service.ts';

/** Calls from the Letta server, authenticated by the shared Letta token. */
export const letta = new Hono();

/**
 * Background-task notifications, forwarded by the Letta mod
 * `infrastructure/letta/extensions/notifications.mjs` instead of Letta's own delivery turn. Any error
 * response makes Letta deliver them natively.
 */
letta.post('/notifications', async (c) => {
  if (!isLettaServer(c.req.raw)) return errorResponse('Unauthorized', 401);
  const body = await jsonObject(c.req.raw);
  const notifications = body?.notifications;
  if (
    typeof body?.conversationId !== 'string' || !body.conversationId || body.conversationId.length > 200 ||
    typeof body.agentId !== 'string' || !body.agentId || body.agentId.length > 200 ||
    !Array.isArray(notifications) ||
    notifications.length < 1 || notifications.length > 100 ||
    !notifications.every((n) => typeof n === 'string' && n.length <= 100_000)
  ) {
    return errorResponse('agentId, conversationId and valid notifications are required', 400);
  }
  const notificationTexts = notifications as string[];
  if (notificationTexts.some((text) => {
    const parsed = extractTaskNotifications(text);
    return parsed.notifications.length !== 1 || parsed.rest.length > 0;
  })) return errorResponse('Each notification must contain exactly one complete task notification', 400);
  try {
    const { agentId, defaultConversationId } = await assistant();
    // Only the assistant's chats are the backend's; anything else stays native.
    if (body.agentId !== agentId || body.conversationId === defaultConversationId) {
      return errorResponse('Not an assistant conversation', 409);
    }
    const retiredTarget = retiredConversationDestination(body.conversationId);
    if (retiredTarget === null) {
      // The exact payload was structurally validated above. A terminal archive
      // tombstone is an explicit acceptance: do not let the mod replay it into
      // Letta's archived source conversation.
      return Response.json({ accepted: 0, acceptedPayload: true }, { status: 202 });
    }
    try {
      await requireConversation(retiredTarget ?? body.conversationId);
    } catch (error) {
      // Retirement can commit after the first tombstone read but before this
      // validation. Re-read the durable route and honor the committed decision.
      const latestTarget = retiredConversationDestination(body.conversationId);
      if (latestTarget === null) {
        return Response.json({ accepted: 0, acceptedPayload: true }, { status: 202 });
      }
      if (error instanceof HttpError && error.status === 404) {
        const archivedId = latestTarget ?? body.conversationId;
        try {
          const archived = await getLettaClient().conversations.retrieve(archivedId);
          if (archived.agent_id === agentId && archived.archived) {
            // An archive may have committed upstream just before its local
            // tombstone. Install it here and explicitly suppress native replay.
            try { await retireConversation(archivedId); }
            catch (retireError) {
              // The provider confirms there is no active destination. Even if
              // tombstone persistence is unavailable, exact acceptance avoids
              // writing this notification into the archived Letta history.
              console.error('[letta] could not persist archive tombstone:', retireError);
            }
            return Response.json({ accepted: 0, acceptedPayload: true }, { status: 202 });
          }
        } catch (lookupError) {
          return errorResponse(lookupError);
        }
      }
      if (latestTarget === undefined) throw error;
      await requireConversation(latestTarget);
    }
    const accepted = await receiveNotifications(body.conversationId, notificationTexts);
    return Response.json({ accepted, acceptedPayload: true }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
});

/** Parallel tool calls are fine; a runaway loop is not. */
const MAX_TOOLS_IN_FLIGHT = 8;
let toolsInFlight = 0;

/**
 * Native tools served to the backend's Letta mods (`internal-tools/mod.ts`):
 * each mod tool POSTs its arguments here and returns the answer to the model.
 */
letta.post('/tools/:name', async (c) => {
  if (!isLettaServer(c.req.raw)) return errorResponse('Unauthorized', 401);
  const name = c.req.param('name');
  const handler = toolHandlers.get(name);
  if (!handler) return errorResponse(`Unknown tool ${name}`, 404);
  if (toolsInFlight >= MAX_TOOLS_IN_FLIGHT) {
    const busy: ToolAnswer = {
      text: 'Too many tool calls at once: try again in a moment.',
      isError: true,
    };
    return Response.json(busy, { status: 429 });
  }
  const body = await jsonObject(c.req.raw, 256_000);
  if (!body) {
    const invalid: ToolAnswer = {
      text: 'The tool arguments were not a JSON object.',
      isError: true,
    };
    return Response.json(invalid, { status: 400 });
  }
  toolsInFlight += 1;
  try {
    return Response.json(await handler(body));
  } catch (error) {
    // Handlers are written not to throw; this is the backstop.
    const failed: ToolAnswer = {
      text: `The ${name} tool failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
    return Response.json(failed);
  } finally {
    toolsInFlight -= 1;
  }
});
