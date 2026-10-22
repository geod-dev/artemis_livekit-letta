import { notImplemented } from '@artemis/core';
import type { CallMode } from '@artemis/contracts/chat-types';
import type { CallControlEvent, CallStateResponse } from '@artemis/contracts/agent-server';

/**
 * Live voice calls, one per conversation (port of
 * backend/src/assistant/calls/state.ts + calls/voice-input.ts). A call is
 * active while the voice agent keeps its control channel open (10 s reconnect
 * grace). Holds mode, `next` (end/listen), `endRequested` (end_call tool),
 * spoken updates announced but not acknowledged, and utterance dedup per call.
 */
export abstract class CallSessions {
  abstract openChannel(conversationId: string, send: (event: CallControlEvent) => void, mode?: CallMode): () => void;
  abstract active(conversationId: string): CallStateResponse | null;
  abstract callId(conversationId: string): string | null;
  /** Tools. False when no call is active. */
  abstract setMode(conversationId: string, mode: CallMode): boolean;
  abstract requestEnd(conversationId: string): boolean;
  /** Voice turn bracket: mode for the turn, then the marker's decision. */
  abstract beginResponse(conversationId: string): CallMode | null;
  abstract finishResponse(conversationId: string, marker: 'listen' | 'done' | null): void;
  abstract announceUpdate(conversationId: string, updateId: string): boolean;
  abstract takeUpdate(conversationId: string, updateId: string): boolean;
  abstract end(conversationId: string): void;
  abstract onEnded(listener: (conversationId: string, pendingUpdateIds: string[]) => void): void;
  /** New user utterances from the OpenAI-style messages (dedup by call + LiveKit item id). */
  abstract newVoiceInput(conversationId: string, callId: string | null, messages: unknown[]): string | null;
}

export function createCallSessions(): CallSessions {
  return notImplemented('createCallSessions');
}
