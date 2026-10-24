import { AppError, type Clock, type Logger, errorMessage, uuid } from '@artemis/core';
import { eventStream } from '@artemis/http';
import { Hono } from 'hono';
import type { CallSessions } from '../calls/call-sessions.ts';
import type { VoiceCompletion, VoiceService } from '../calls/voice-service.ts';
import type { ConversationService } from '../conversations/service.ts';
import type { BackgroundDeliveryService } from '../tasks/delivery.ts';
import { noContent } from './http.ts';
import {
  MAX_VOICE_MESSAGES,
  requireBody,
  requireUuidParam,
  validCallId,
  validMessages,
} from './validation.ts';

/**
 * Voice endpoints used by the LiveKit voice agent (docs/architecture.md, "How the services talk"):
 * OpenAI-compatible completions, the control channel of a call, spoken updates. The sequencing
 * of a voice turn is in `calls/voice-service.ts`; these routes parse, call and encode the stream.
 */
const MODEL = 'artemis';
const SORRY = "Sorry, I couldn't process that.";

/** The ports the voice routes use (narrow: the routes never reach the workers). */
export interface VoiceRouteDeps {
  clock: Clock;
  logger: Logger;
  conversations: Pick<ConversationService, 'require'>;
  calls: CallSessions;
  delivery: Pick<BackgroundDeliveryService, 'markRead'>;
  voice: VoiceService;
}

export function voiceRoutes(deps: VoiceRouteDeps): Hono {
  const voice = new Hono();
  const log = deps.logger;

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
      throw new AppError('invalid_messages', `messages must be a valid list with at most ${MAX_VOICE_MESSAGES} entries`, 400);
    }

    const { stream, write, chunk, controller } = completionStream(deps.clock);
    let completion: VoiceCompletion;
    try {
      completion = await deps.voice.complete(id, {
        messages: body.messages,
        callId: validCallId(req.headers.get('x-voice-call-id')),
        signal: req.signal,
        onText: (delta) => write(chunk({ content: delta })),
      });
    } catch (error) {
      await stream.cancel().catch(() => undefined);
      throw error;
    }

    write(chunk({ role: 'assistant', content: '' }));
    void completion.finished
      .then(({ apology }) => {
        if (apology) write(chunk({ content: SORRY }));
        write(chunk({}, 'stop'));
        write('data: [DONE]\n\n');
        controller.close();
      })
      .catch((error: unknown) => {
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

    const { stream, write, controller } = completionStream(deps.clock);
    const speech = await deps.voice.speakUpdate(id, updateId, {
      signal: req.signal,
      onText: (delta) => write(delta),
    });

    void speech.finished
      .then((outcome) => {
        if (outcome.status === 'failed') controller.error(new Error(outcome.error ?? 'update failed'));
        else controller.close();
      })
      .catch((error: unknown) => {
        log.error('update stream failed', { updateId, error: errorMessage(error) });
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
