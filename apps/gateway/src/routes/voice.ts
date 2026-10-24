import { voicePath } from '@artemis/contracts/agent-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AgentServerClient } from '../agent-server/client.ts';
import {
  PROXY_BODY_LIMIT,
  bearerToken,
  errorResponse,
  jsonObject,
  requestLimit,
  routeError,
  withQuery,
} from '../http.ts';
import { sameSecret } from '../security.ts';

/** The LiveKit token port of the voice routes; the vendor is chosen in compose. */
export interface VoiceTokenPort {
  forCall(conversationId: string, callMode: 'short' | 'long'): Promise<VoiceToken>;
  warmup(): Promise<VoiceToken>;
}

/** The browser's connection details for a LiveKit room. */
interface VoiceToken {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
}

/**
 * The voice agent's endpoints, authenticated by its bearer token inside this router. The
 * gateway's session gate lets these paths through, so this router's check is the only one.
 */
export const VOICE_AGENT_PATH_PREFIX = '/api/voice/conversations/';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };
/** The token request is a conversation id and a mode; anything larger is not one. */
const TOKEN_BODY_LIMIT = 16 * 1024;

interface VoiceRouteDeps {
  agentServer: AgentServerClient;
  voiceTokens: VoiceTokenPort;
  /** The voice agent's shared bearer token, required on its endpoints. */
  voiceGatewayToken: string;
}

/**
 * Voice calls. The gateway issues LiveKit tokens to the browser and relays the
 * voice agent's endpoints (authenticated by its shared bearer token) to the
 * agent-server, which owns the call state, the voice turns and their delivery.
 */
export function createVoiceRoutes({
  agentServer,
  voiceTokens,
  voiceGatewayToken,
}: VoiceRouteDeps): Hono {
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
  voice.post('/token', requestLimit(TOKEN_BODY_LIMIT), async (c) => {
    try {
      const body = await jsonObject(c.req.raw, TOKEN_BODY_LIMIT);
      if (!body) return errorResponse('Body must be a JSON object', 400);
      const conversationId = body.conversationId;
      const mode = body.mode;
      if (mode !== undefined && mode !== 'short' && mode !== 'long')
        return errorResponse('mode must be short or long', 400);
      if (conversationId === undefined)
        return Response.json({ ...(await voiceTokens.warmup()), conversation: null }, NO_STORE);
      if (typeof conversationId !== 'string' || conversationId.length > 200)
        return errorResponse('conversationId is invalid', 400);
      const conversation = await agentServer.conversation(conversationId);
      // Open the session and configure voice effort and thinking before the user speaks.
      void agentServer.warm(conversation.id, 'voice').catch((error) => {
        console.error('[voice] warm-up failed', error);
      });
      const token = await voiceTokens.forCall(conversation.id, mode === 'long' ? 'long' : 'short');
      return Response.json({ ...token, conversation }, NO_STORE);
    } catch (error) {
      return errorResponse(error);
    }
  });

  // The voice agent's endpoints.
  voice.use('/conversations/*', async (c, next) => {
    if (!sameSecret(bearerToken(c.req.raw), voiceGatewayToken))
      return errorResponse('Unauthorized', 401);
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
    agentServer.relay(c.req.raw, `${voicePath(c.req.param('id'))}/chat/completions`)
  );

  /** The voice agent's control channel for one call; `?mode=long` opens a new call in long mode. */
  voice.get('/conversations/:id/call', (c) =>
    agentServer.relay(c.req.raw, withQuery(c, `${voicePath(c.req.param('id'))}/call`))
  );

  voice.get('/conversations/:id/call/state', (c) =>
    agentServer.relay(c.req.raw, `${voicePath(c.req.param('id'))}/call/state`)
  );

  /** Speaks a queued background update: the agent-server runs its voice turn and streams the text. */
  voice.post('/conversations/:id/call/updates/:updateId', (c) =>
    agentServer.relay(
      c.req.raw,
      `${voicePath(c.req.param('id'))}/call/updates/${encodeURIComponent(c.req.param('updateId'))}`
    )
  );

  voice.post('/conversations/:id/call/updates/:updateId/ack', (c) =>
    agentServer.relay(
      c.req.raw,
      `${voicePath(c.req.param('id'))}/call/updates/${encodeURIComponent(c.req.param('updateId'))}/ack`
    )
  );

  /** The call ended: unspoken updates go to the chat. */
  voice.post('/conversations/:id/ended', (c) =>
    agentServer.relay(c.req.raw, `${voicePath(c.req.param('id'))}/ended`)
  );

  return voice;
}
