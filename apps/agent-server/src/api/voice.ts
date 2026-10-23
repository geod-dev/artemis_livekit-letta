import { AppError, type Clock, consoleLogger, errorMessage, uuid } from '@artemis/core';
import { eventStream } from '@artemis/http';
import { Hono } from 'hono';
import type { TurnMode } from '@artemis/contracts/chat-types';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { TurnHandle } from '../conversations/service.ts';
import type { ApiDependencies } from './deps.ts';
import { isCallId, requireUuidParam } from './guards.ts';
import { noContent, requireBody } from './http.ts';

/**
 * Voice endpoints used by the LiveKit voice agent (docs/architecture.md, "How the services talk"):
 * OpenAI-compatible completions, the control channel of a call, spoken
 * updates. Every voice response is bracketed on the call (`beginResponse` when
 * it starts, `finishResponse` when it ends).
 */
const MODEL = 'artemis';
const MAX_MESSAGES = 100;
const MAX_CONTENT = 100_000;
const SORRY = "Sorry, I couldn't process that.";
const log = consoleLogger('voice');

export function voiceRoutes(deps: ApiDependencies): Hono {
  const voice = new Hono();

  const requireConversationId = requireUuidParam('id', 'Conversation');
  const requireUpdateId = requireUuidParam('updateId', 'Update');
  voice.use('/conversations/:id/*', requireConversationId);
  voice.use('/conversations/:id/call/updates/:updateId', requireUpdateId);
  voice.use('/conversations/:id/call/updates/:updateId/ack', requireUpdateId);

  voice.post('/conversations/:id/chat/completions', async (c) => {
    const id = c.req.param('id');
    const req = c.req.raw;
    await deps.conversations.require(id);
    const body = await requireBody(req);
    if (!validMessages(body.messages)) {
      throw new AppError('invalid_messages', `messages must be a valid list with at most ${MAX_MESSAGES} entries`, 400);
    }
    // A call id the client sends is trusted only when it has the call id format; otherwise the open call's id is used.
    const callId = validCallId(req.headers.get('x-voice-call-id')) ?? deps.calls.callId(id);
    const utterance = deps.calls.newVoiceInput(id, callId, body.messages);
    const identities = utterance?.identities ?? [];

    const { stream, write, chunk, controller } = completionStream(deps.clock);
    let handle: TurnHandle | null = null;
    if (utterance) {
      try {
        handle = await deps.conversations.submitVoiceTurn(id, {
          text: utterance.text,
          ...(utterance.clientMessageId ? { clientMessageId: utterance.clientMessageId } : {}),
          mode: () => voiceTurnMode(deps.calls, id),
          signal: req.signal,
          onText: (delta) => write(chunk({ content: delta })),
        });
      } catch (error) {
        await stream.cancel().catch(() => undefined);
        throw error;
      }
      deps.calls.acceptVoiceInput(id, callId, identities);
    }

    write(chunk({ role: 'assistant', content: '' }));
    void (async () => {
      if (handle) {
        const outcome = await handle.done;
        if (outcome.status === 'completed') {
          deps.calls.finishResponse(id, outcome.callState ?? null);
        } else {
          deps.calls.rejectVoiceInput(id, callId, identities);
          deps.calls.finishResponse(id, null);
          if (outcome.status === 'failed' && !outcome.text) write(chunk({ content: SORRY }));
        }
      }
      write(chunk({}, 'stop'));
      write('data: [DONE]\n\n');
      controller.close();
    })().catch((error: unknown) => {
      log.error('completion stream failed', { error: errorMessage(error) });
      try {
        controller.error(error);
      } catch {
        // already closed by the client
      }
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  });

  /** The control channel of one call (`ControlEvent`s), open while the agent is connected. */
  voice.get('/conversations/:id/call', async (c) => {
    const id = c.req.param('id');
    await deps.conversations.require(id);
    const mode = c.req.query('mode') === 'long' ? 'long' : 'short';
    return eventStream(c.req.raw, (send) => deps.calls.openChannel(id, (event) => send(event), mode));
  });

  voice.get('/conversations/:id/call/state', async (c) => {
    const id = c.req.param('id');
    await deps.conversations.require(id);
    return Response.json(deps.calls.active(id) ?? { mode: 'short', next: 'listen' });
  });

  /** Speaks a queued background update: runs its voice turn and streams the text. */
  voice.post('/conversations/:id/call/updates/:updateId', async (c) => {
    const { id, updateId } = c.req.param();
    const req = c.req.raw;
    await deps.conversations.require(id);
    const claimed = await deps.delivery.claimQueued(id, updateId);
    if (!claimed) throw new AppError('not_found', 'No such pending update', 404);
    const { token, update } = claimed;

    const { stream, write, controller } = completionStream(deps.clock);
    let handle: TurnHandle;
    try {
      handle = await deps.conversations.submitUpdateTurn(id, {
        update,
        deliveryToken: token,
        mode: () => voiceTurnMode(deps.calls, id),
        signal: req.signal,
        onText: (delta) => write(delta),
      });
    } catch (error) {
      await deps.delivery.rollback(id, token);
      throw error;
    }

    void (async () => {
      const outcome = await handle.done;
      if (outcome.status === 'completed') {
        await deps.delivery.complete(id, token, outcome.turnId);
        deps.calls.takeUpdate(id, updateId);
      } else {
        await deps.delivery.rollback(id, token);
      }
      deps.calls.finishResponse(id, null);
      if (outcome.status === 'failed') controller.error(new Error(outcome.error ?? 'update failed'));
      else controller.close();
    })().catch(async (error: unknown) => {
      log.error('update stream failed', { updateId, error: errorMessage(error) });
      await deps.delivery.rollback(id, token).catch(() => undefined);
      try {
        controller.error(error);
      } catch {
        // already closed by the client
      }
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  });

  /** The voice agent finished a spoken update. Heard completely counts as read. */
  voice.post('/conversations/:id/call/updates/:updateId/ack', async (c) => {
    const { id, updateId } = c.req.param();
    await deps.conversations.require(id);
    const body = await requireBody(c.req.raw);
    if (typeof body.heard !== 'boolean') throw new AppError('invalid_field', 'heard must be a boolean', 400);
    if (body.heard) await deps.delivery.markRead(id, [updateId]);
    return noContent();
  });

  /** The call is over: unspoken updates go to the chat (through the `onEnded` listener). */
  voice.post('/conversations/:id/ended', async (c) => {
    const id = c.req.param('id');
    await deps.conversations.require(id);
    deps.calls.end(id);
    return noContent();
  });

  return voice;
}

function validCallId(header: string | null): string | null {
  return header !== null && isCallId(header) ? header : null;
}

/**
 * Mode of a voice response: the call's mode (no call counts as short), and a fresh end request.
 * Called once the main agent is ready, so a failed start does not begin a response.
 */
function voiceTurnMode(calls: CallSessions, conversationId: string): TurnMode {
  return calls.beginResponse(conversationId) === 'long' ? 'voice-long' : 'voice-short';
}

/**
 * A streaming response whose controller exists as soon as the stream is
 * created (ReadableStream `start` runs synchronously), so the caller can
 * submit a turn before returning the response.
 */
function completionStream(clock: Clock): {
  stream: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  write: (value: string) => void;
  chunk: (delta: Record<string, unknown>, finishReason?: string | null) => string;
} {
  const encoder = new TextEncoder();
  const completionId = `chatcmpl-${uuid()}`;
  const created = Math.floor(clock.now() / 1000);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const write = (value: string) => {
    try {
      controller.enqueue(encoder.encode(value));
    } catch {
      // client disconnected
    }
  };
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: MODEL,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  return { stream, controller, write, chunk };
}

function validMessages(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) return false;
  return value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    if (typeof row.role !== 'string' || row.role.length > 32) return false;
    const content = row.content;
    if (content === undefined || content === null) return true;
    if (typeof content === 'string') return content.length <= MAX_CONTENT;
    if (Array.isArray(content)) {
      return (
        content.length <= MAX_MESSAGES &&
        content.every((part) => {
          if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
          return !('text' in part) || typeof (part as { text?: unknown }).text === 'string';
        })
      );
    }
    return false;
  });
}
