import { Hono } from 'hono';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import { claimQueuedUpdate, completeDelivery, markRead, rollbackDelivery } from '../assistant/background/service.ts';
import { activeCallId, callState, endCall, openCallChannel, takeUpdate } from '../assistant/calls/state.ts';
import { config } from '../assistant/config';
import { requireConversation } from '../assistant/conversations/service.ts';
import { conversationRuntime } from '../assistant/runtime';
import { forgetVoiceInput, newVoiceInput, rememberVoiceInput, voiceInputMessageId, voiceInputMessageIds } from '../assistant/calls/voice-input.ts';
import { errorResponse, eventStream, isVoiceAgent, jsonObject } from '../http';

/**
 * Voice calls: tokens for the browser, and the endpoints of the voice agent
 * (authenticated by its shared bearer token).
 */
export const voice = new Hono();

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

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
 * Protected by the backend's browser-session authentication.
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
    const conversation = await requireConversation(conversationId);
    // Open the Letta session and configure voice effort and thinking before the user speaks.
    void conversationRuntime(conversation.id)
      .warm('voice')
      .catch((error) => {
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

// The voice agent's endpoints.
voice.use('/conversations/*', async (c, next) => {
  if (!isVoiceAgent(c.req.raw)) return errorResponse('Unauthorized', 401);
  await next();
});

/**
 * OpenAI-compatible Chat Completions endpoint scoped to one conversation, so
 * the LiveKit agent can use the stock `openai.LLM` plugin as its LLM.
 *
 * The conversation is stateful in Letta, so only the new user utterance is
 * forwarded; the history LiveKit sends is ignored. The reply streams back
 * token by token while the same turn is published to open chat views.
 * Closing the request (user interruption) aborts the Letta turn.
 */
voice.post('/conversations/:id/v1/chat/completions', async (c) => {
  const id = c.req.param('id');
  const req = c.req.raw;
  const body = await jsonObject(req);
  if (!body || !Array.isArray(body.messages) || body.messages.length > 100 || body.messages.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
    const row = item as Record<string, unknown>;
    return typeof row.role !== 'string' || row.role.length > 32 || (row.content !== undefined && typeof row.content !== 'string' && !Array.isArray(row.content)) || (typeof row.content === 'string' && row.content.length > 100_000) || (Array.isArray(row.content) && (row.content.length > 100 || row.content.some((part) => !part || typeof part !== 'object' || Array.isArray(part) || (('text' in part) && typeof (part as { text?: unknown }).text !== 'string'))));
  })) return errorResponse('messages must be a valid list with at most 100 entries', 400);
  try { await requireConversation(id); } catch (error) { return errorResponse(error); }
  const messages = body.messages as unknown[];
  const suppliedCallId = req.headers.get('x-voice-call-id');
  if (suppliedCallId && suppliedCallId.length > 200) return errorResponse('x-voice-call-id is too long', 400);
  const callId = suppliedCallId || activeCallId(id);
  const text = newVoiceInput(id, messages, callId);
  const identity = voiceInputMessageId(messages);

  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: 'letta',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;

  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const queued: string[] = [];
  const write = (value: string) => {
    if (!controller) { queued.push(value); return; }
    try { controller.enqueue(encoder.encode(value)); } catch { /* client disconnected */ }
  };
  const admitted = text ? conversationRuntime(id).tryRun({
    text,
    modality: 'voice',
    signal: req.signal,
    ...(identity ? { clientMessageId: identity } : {}),
    onText: (delta) => write(chunk({ content: delta })),
  }) : null;
  if (text && !admitted) return errorResponse('Conversation is busy; retry the voice input', 429);
  const admittedMessageIds = admitted ? voiceInputMessageIds(messages) : [];
  for (const messageId of admittedMessageIds) rememberVoiceInput(id, callId, messageId);
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      for (const value of queued.splice(0)) write(value);
      void (async () => {
      write(chunk({ role: 'assistant', content: '' }));
      if (admitted) {
        const outcome = await admitted;
        if (!outcome.success) for (const messageId of admittedMessageIds) forgetVoiceInput(id, callId, messageId);
        if (!outcome.success && outcome.error !== 'aborted' && !outcome.text) {
          console.error('[voice] turn failed:', outcome.error);
          write(chunk({ content: "Sorry, I couldn't process that." }));
        }
      }
      write(chunk({}, 'stop'));
      write('data: [DONE]\n\n');
      try {
        controller.close();
      } catch {}
      })().catch((error) => {
        console.error('[voice] stream failed:', error);
        for (const messageId of admittedMessageIds) forgetVoiceInput(id, callId, messageId);
        try { controller?.error(error); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
});

/**
 * The voice agent's control channel for one call. The call counts as active
 * while it is open; it carries notices of spoken updates to deliver.
 * `?mode=long` opens a new call in long mode (default: short).
 */
voice.get('/conversations/:id/call', async (c) => {
  const id = c.req.param('id');
  try { await requireConversation(id); } catch (error) { return errorResponse(error); }
  const mode = c.req.query('mode') === 'long' ? 'long' : 'short';
  return eventStream(c.req.raw, (send) => openCallChannel(id, send, mode));
});

/** The call mode, and whether the call ends once the latest response has played. */
voice.get('/conversations/:id/call/state', async (c) => {
  try { const id = c.req.param('id'); await requireConversation(id); return Response.json(callState(id)); }
  catch (error) { return errorResponse(error); }
});

/**
 * The voice agent speaks a queued background update: this runs the update's
 * voice turn and streams its text as plain text. Closing the request (the user
 * interrupted) aborts the turn. Each update is generated once.
 */
voice.post('/conversations/:id/call/updates/:updateId', async (c) => {
  const { id, updateId } = c.req.param();
  const req = c.req.raw;
  try { await requireConversation(id); } catch (error) { return errorResponse(error); }
  const update = await claimQueuedUpdate(id, updateId);
  if (!update) return errorResponse('No such pending update', 404);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const outcome = await conversationRuntime(id).run({
          kind: 'update', modality: 'voice', text: '', updates: [update], signal: req.signal,
          onText: (delta) => { try { controller.enqueue(encoder.encode(delta)); } catch {} },
        });
        if (outcome.success) {
          await completeDelivery(id, update.id, update.deliveryToken!);
          takeUpdate(id, updateId);
        }
        else await rollbackDelivery(id, update.id, update.deliveryToken!);
        if (!outcome.success && outcome.error !== 'aborted') {
          console.error('[voice] update turn failed:', outcome.error);
          controller.error(new Error(outcome.error ?? 'update failed'));
          return;
        }
        try { controller.close(); } catch {}
      } catch (error) {
        await rollbackDelivery(id, update.id, update.deliveryToken!);
        try { controller.error(error); } catch {}
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
});

/**
 * The voice agent finished with a spoken update. Hearing it completely counts
 * as reading it; an interrupted or failed delivery leaves it unread.
 */
voice.post('/conversations/:id/call/updates/:updateId/ack', async (c) => {
  const { id, updateId } = c.req.param();
  try { await requireConversation(id); } catch (error) { return errorResponse(error); }
  const body = await jsonObject(c.req.raw);
  if (!body || typeof body.heard !== 'boolean') return errorResponse('heard must be a boolean', 400);
  const heard = body.heard;
  if (heard) await markRead(id, [updateId]);
  return Response.json({ heard: heard === true });
});

/**
 * Called by the voice agent when a call ends. Updates that were never spoken
 * go to the chat, and memory learning happens here, after the realtime path:
 * Letta launches a background reflection subagent that reviews the call
 * transcript and commits memory updates.
 */
voice.post('/conversations/:id/ended', async (c) => {
  const id = c.req.param('id');
  try { await requireConversation(id); } catch (error) { return errorResponse(error); }
  endCall(id);
  void conversationRuntime(id)
    .reflect()
    .catch((error) => console.error('[voice] reflection failed to start', error));
  return Response.json({ accepted: true }, { status: 202 });
});
