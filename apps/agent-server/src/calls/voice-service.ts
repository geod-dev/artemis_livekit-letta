import { NotFoundError } from '@artemis/core';
import type { TurnMode } from '@artemis/contracts/chat-types';
import type { ConversationService, TurnHandle, TurnOutcome } from '../conversations/service.ts';
import type { BackgroundDeliveryService } from '../tasks/delivery.ts';
import type { CallSessions } from './call-sessions.ts';

/**
 * Voice turns of a live call: a completion request admits the new utterance and runs it as a
 * turn; a spoken update claims a queued background update and runs it as a turn. The HTTP
 * routes parse, call and encode the stream; the sequencing of the call state lives here.
 */

export interface VoiceCompletionInput {
  messages: Array<Record<string, unknown>>;
  /** The call id the client sent (already in the call id format), or null for the open call. */
  callId: string | null;
  signal: AbortSignal;
  onText: (delta: string) => void;
}

export interface VoiceCompletion {
  /** Resolves when the response is finished on the call. `apology` asks for the spoken fallback. */
  finished: Promise<{ apology: boolean }>;
}

export interface VoiceUpdateInput {
  signal: AbortSignal;
  onText: (delta: string) => void;
}

export interface VoiceUpdateSpeech {
  /** Resolves with the turn outcome once the update is completed or rolled back. Rejects only on a failure. */
  finished: Promise<TurnOutcome>;
}

export interface VoiceService {
  complete(conversationId: string, input: VoiceCompletionInput): Promise<VoiceCompletion>;
  speakUpdate(conversationId: string, updateId: string, input: VoiceUpdateInput): Promise<VoiceUpdateSpeech>;
}

export interface VoiceServiceDeps {
  conversations: Pick<ConversationService, 'submitVoiceTurn' | 'submitUpdateTurn'>;
  calls: CallSessions;
  delivery: Pick<BackgroundDeliveryService, 'claimQueued' | 'complete' | 'rollback'>;
}

/** Mode of a voice response: the call's mode (no call counts as short), and a fresh end request. */
function voiceTurnMode(calls: CallSessions, conversationId: string): TurnMode {
  return calls.beginResponse(conversationId) === 'long' ? 'voice-long' : 'voice-short';
}

export function createVoiceService(deps: VoiceServiceDeps): VoiceService {
  const { conversations, calls, delivery } = deps;

  return {
    async complete(conversationId, input) {
      const callId = input.callId ?? calls.callId(conversationId);
      const utterance = calls.newVoiceInput(conversationId, callId, input.messages);
      if (!utterance) return { finished: Promise.resolve({ apology: false }) };

      const handle: TurnHandle = await conversations.submitVoiceTurn(conversationId, {
        text: utterance.text,
        ...(utterance.clientMessageId ? { clientMessageId: utterance.clientMessageId } : {}),
        mode: () => voiceTurnMode(calls, conversationId),
        signal: input.signal,
        onText: input.onText,
      });
      calls.acceptVoiceInput(conversationId, callId, utterance.identities);

      const finished = handle.done.then((outcome) => {
        if (outcome.status === 'completed') {
          calls.finishResponse(conversationId, outcome.callState ?? null);
        } else {
          calls.rejectVoiceInput(conversationId, callId, utterance.identities);
          calls.finishResponse(conversationId, null);
        }
        return { apology: outcome.status === 'failed' && !outcome.text };
      });
      return { finished };
    },

    async speakUpdate(conversationId, updateId, input) {
      const claimed = await delivery.claimQueued(conversationId, updateId);
      if (!claimed) throw new NotFoundError('Pending update');
      const { token, update } = claimed;

      let handle: TurnHandle;
      try {
        handle = await conversations.submitUpdateTurn(conversationId, {
          update,
          deliveryToken: token,
          mode: () => voiceTurnMode(calls, conversationId),
          signal: input.signal,
          onText: input.onText,
        });
      } catch (error) {
        await delivery.rollback(conversationId, token);
        throw error;
      }

      const finished = handle.done
        .then(async (outcome) => {
          if (outcome.status === 'completed') {
            await delivery.complete(conversationId, token, outcome.turnId);
            calls.takeUpdate(conversationId, updateId);
          } else {
            await delivery.rollback(conversationId, token);
          }
          calls.finishResponse(conversationId, null);
          return outcome;
        })
        .catch(async (error: unknown) => {
          await delivery.rollback(conversationId, token).catch(() => undefined);
          throw error;
        });
      return { finished };
    },
  };
}
