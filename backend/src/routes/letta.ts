import { Hono } from 'hono';
import { receiveNotifications } from '../assistant/background';
import { assistant } from '../assistant/letta';
import { errorResponse, isLettaServer } from '../http';
import type { ToolAnswer } from '../internal-tools/types';
import { toolHandlers } from '../mcp/native-tools';

/** Calls from the Letta server, authenticated by the shared Letta token. */
export const letta = new Hono();

/**
 * Background-task notifications, forwarded by the Letta mod
 * `letta/notifications.mjs` instead of Letta's own delivery turn. Any error
 * response makes Letta deliver them natively.
 */
letta.post('/notifications', async (c) => {
  if (!isLettaServer(c.req.raw)) return errorResponse('Unauthorized', 401);
  const body = (await c.req.json().catch(() => null)) as {
    agentId?: string;
    conversationId?: string;
    notifications?: unknown;
  } | null;
  const notifications = body?.notifications;
  if (
    !body?.conversationId ||
    !Array.isArray(notifications) ||
    !notifications.every((n) => typeof n === 'string')
  ) {
    return errorResponse('conversationId and notifications are required', 400);
  }
  try {
    const { agentId, defaultConversationId } = await assistant();
    // Only the assistant's chats are the backend's; anything else stays native.
    if (body.agentId !== agentId || body.conversationId === defaultConversationId) {
      return errorResponse('Not an assistant conversation', 409);
    }
    const accepted = receiveNotifications(body.conversationId, notifications);
    return Response.json({ accepted }, { status: 202 });
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
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const invalid: ToolAnswer = {
      text: 'The tool arguments were not a JSON object.',
      isError: true,
    };
    return Response.json(invalid, { status: 400 });
  }
  toolsInFlight += 1;
  try {
    return Response.json(await handler(body as Record<string, unknown>));
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
