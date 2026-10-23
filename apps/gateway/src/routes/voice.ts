import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import type { AgentServerClient } from '../agent-server/client';
import { config } from '../assistant/config';
import { errorResponse, isVoiceAgent, jsonObject, PROXY_BODY_LIMIT, routeError, withQuery } from '../http';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Voice calls. The gateway issues LiveKit tokens to the browser and relays the
 * voice agent's endpoints (authenticated by its shared bearer token) to the
 * agent-server, which owns the call state, the voice turns and their delivery.
 */
export function createVoiceRoutes(agent: AgentServerClient): Hono {
  const voice = new Hono();
  voice.onError(routeError);

  /**
   * Start (or continue) a voice call on a conversation. The token dispatches the
   * voice agent into a fresh room with the conversation id in its job metadata.
   *
   * Without a conversationId the token only lets LiveKit warm up its connection
   * (`useSession` fetches one on mount and after each call): no room agent, no
   * conversation. The client creates the conversation before starting a call.
   * `mode` is the call's starting mode ("short" unless "long" is asked for); the
   * agent opens the call in it, and the set_call_mode tool can still switch it.
   *
   * Protected by the gateway's browser-session authentication.
   */
  voice.post('/token', async (c) => {
    try {
      const body = await jsonObject(c.req.raw);
      if (!body) return errorResponse('Body must be a JSON object', 400);
      const conversationId = body.conversationId;
      const mode = body.mode;
      if (mode !== undefined && mode !== 'short' && mode !== 'long') return errorResponse('mode must be short or long', 400);
      if (conversationId === undefined) return Response.json(await warmupToken(), NO_STORE);
      if (typeof conversationId !== 'string' || conversationId.length > 200) return errorResponse('conversationId is invalid', 400);
      const conversation = await agent.conversation(conversationId);
      // Open the session and configure voice effort and thinking before the user speaks.
      void agent.warm(conversation.id, 'voice').catch((error) => {
        console.error('[voice] warm-up failed', error);
      });

      const roomName = `call-${conversation.id}-${randomUUID().slice(0, 8)}`;
      const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
        identity: `user-${randomUUID().slice(0, 8)}`,
        name: 'user',
        ttl: '30m',
      });
      token.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canPublishData: true,
        canSubscribe: true,
      });
      token.roomConfig = new RoomConfiguration({
        agents: [
          new RoomAgentDispatch({
            agentName: config.livekit.agentName,
            metadata: JSON.stringify({
              conversation_id: conversation.id,
              call_mode: mode === 'long' ? 'long' : 'short',
            }),
          }),
        ],
      });

      return Response.json(
        {
          serverUrl: config.livekit.url,
          roomName,
          participantName: 'user',
          participantToken: await token.toJwt(),
          conversation,
        },
        NO_STORE
      );
    } catch (error) {
      return errorResponse(error);
    }
  });

  // The voice agent's endpoints.
  voice.use('/conversations/*', async (c, next) => {
    if (!isVoiceAgent(c.req.raw)) return errorResponse('Unauthorized', 401);
    await next();
  });
  voice.use('/conversations/*', bodyLimit({ maxSize: PROXY_BODY_LIMIT }));

  /**
   * OpenAI-compatible Chat Completions endpoint scoped to one conversation, so
   * the LiveKit agent can use the stock `openai.LLM` plugin. The agent-server
   * streams the reply and aborts the turn when this request is closed (user
   * interruption).
   */
  voice.post('/conversations/:id/v1/chat/completions', (c) =>
    agent.relay(c.req.raw, `${voicePath(c.req.param('id'))}/chat/completions`)
  );

  /** The voice agent's control channel for one call; `?mode=long` opens a new call in long mode. */
  voice.get('/conversations/:id/call', (c) => agent.relay(c.req.raw, withQuery(c, `${voicePath(c.req.param('id'))}/call`)));

  voice.get('/conversations/:id/call/state', (c) =>
    agent.relay(c.req.raw, `${voicePath(c.req.param('id'))}/call/state`)
  );

  /** Speaks a queued background update: the agent-server runs its voice turn and streams the text. */
  voice.post('/conversations/:id/call/updates/:updateId', (c) =>
    agent.relay(c.req.raw, `${voicePath(c.req.param('id'))}/call/updates/${encodeURIComponent(c.req.param('updateId'))}`)
  );

  voice.post('/conversations/:id/call/updates/:updateId/ack', (c) =>
    agent.relay(
      c.req.raw,
      `${voicePath(c.req.param('id'))}/call/updates/${encodeURIComponent(c.req.param('updateId'))}/ack`
    )
  );

  /** The call ended: unspoken updates go to the chat. */
  voice.post('/conversations/:id/ended', (c) => agent.relay(c.req.raw, `${voicePath(c.req.param('id'))}/ended`));

  return voice;
}

function voicePath(id: string): string {
  return `/v1/voice/conversations/${encodeURIComponent(id)}`;
}

async function warmupToken() {
  const roomName = `warmup-${randomUUID().slice(0, 8)}`;
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: `user-${randomUUID().slice(0, 8)}`,
    name: 'user',
    ttl: '5m',
  });
  token.addGrant({ room: roomName, roomJoin: true });
  return {
    serverUrl: config.livekit.url,
    roomName,
    participantName: 'user',
    participantToken: await token.toJwt(),
    conversation: null,
  };
}
