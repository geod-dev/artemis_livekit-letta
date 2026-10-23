import { type Clock, prefixedId, systemClock } from '@artemis/core';
import type { CallMode } from '@artemis/contracts/chat-types';
import type { CallControlEvent, CallStateResponse } from '@artemis/contracts/agent-server';
import { type VoiceUtterance, VoiceInputLedger, trailingUserEntries } from './voice-input.ts';

/**
 * Live voice calls, one per conversation (port of backend/src/assistant/calls/state.ts).
 * A call is active while the voice agent keeps its control channel open; a
 * dropped channel ends the call unless the agent reconnects within the grace
 * period. Holds the mode, `next` (end/listen), `endRequested` (end_call tool),
 * spoken updates announced but not acknowledged, and utterance dedup per call.
 *
 * Bracket of one voice response (called by the voice routes, not by the worker):
 * `beginResponse` when the response is submitted, `finishResponse` with the
 * marker of a successful reply (`null` otherwise).
 */
type CallEndListener = (conversationId: string, pendingUpdateIds: string[]) => void;

export abstract class CallSessions {
  abstract openChannel(conversationId: string, send: (event: CallControlEvent) => void, mode?: CallMode): () => void;
  abstract active(conversationId: string): CallStateResponse | null;
  abstract callId(conversationId: string): string | null;
  /** Tools. False when no call is active. */
  abstract setMode(conversationId: string, mode: CallMode): boolean;
  abstract requestEnd(conversationId: string): boolean;
  /** Voice response bracket: the call's mode for the response, and a fresh end request. */
  abstract beginResponse(conversationId: string): CallMode | null;
  abstract finishResponse(conversationId: string, marker: 'listen' | 'done' | null): void;
  abstract announceUpdate(conversationId: string, updateId: string): boolean;
  abstract takeUpdate(conversationId: string, updateId: string): boolean;
  /** Ends the call; listeners receive the spoken updates that were never acknowledged. */
  abstract end(conversationId: string): void;
  /** Returns the unsubscribe function. */
  abstract onEnded(listener: CallEndListener): () => void;
  /** New user utterances of the OpenAI-style message list, or null when nothing new. */
  abstract newVoiceInput(conversationId: string, callId: string | null, messages: unknown[]): VoiceUtterance | null;
  /** Admission of an utterance (after the turn was accepted) and its release (turn did not complete). */
  abstract acceptVoiceInput(conversationId: string, callId: string | null, identities: string[]): void;
  abstract rejectVoiceInput(conversationId: string, callId: string | null, identities: string[]): void;
}

interface Call {
  conversationId: string;
  callId: string;
  mode: CallMode;
  next: 'end' | 'listen';
  endRequested: boolean;
  channels: Set<(event: CallControlEvent) => void>;
  /** Spoken updates announced to the voice agent and not yet acknowledged. */
  updates: Set<string>;
  closeTimer: { cancel(): void } | null;
}

/** A dropped control channel ends the call unless the agent reconnects in time. */
const RECONNECT_GRACE_MS = 10_000;

export class LocalCallSessions extends CallSessions {
  private readonly calls = new Map<string, Call>();
  private readonly listeners = new Set<CallEndListener>();
  private readonly voiceInputs: VoiceInputLedger;

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly reconnectGraceMs = RECONNECT_GRACE_MS
  ) {
    super();
    this.voiceInputs = new VoiceInputLedger(clock);
  }

  openChannel(conversationId: string, send: (event: CallControlEvent) => void, mode: CallMode = 'short'): () => void {
    let call = this.calls.get(conversationId);
    if (!call) {
      call = {
        conversationId,
        callId: prefixedId('call'),
        mode,
        next: 'listen',
        endRequested: false,
        channels: new Set(),
        updates: new Set(),
        closeTimer: null,
      };
      this.calls.set(conversationId, call);
    }
    call.closeTimer?.cancel();
    call.closeTimer = null;
    call.channels.add(send);
    // A reconnecting agent lost its queue: announce the pending updates again.
    for (const id of call.updates) send({ type: 'update', id });

    const opened = call;
    return () => {
      opened.channels.delete(send);
      if (opened.channels.size > 0 || this.calls.get(conversationId) !== opened) return;
      opened.closeTimer = this.clock.setTimeout(() => this.end(conversationId), this.reconnectGraceMs);
    };
  }

  active(conversationId: string): CallStateResponse | null {
    const call = this.calls.get(conversationId);
    return call ? { mode: call.mode, next: call.next } : null;
  }

  callId(conversationId: string): string | null {
    return this.calls.get(conversationId)?.callId ?? null;
  }

  setMode(conversationId: string, mode: CallMode): boolean {
    const call = this.calls.get(conversationId);
    if (call) call.mode = mode;
    return Boolean(call);
  }

  requestEnd(conversationId: string): boolean {
    const call = this.calls.get(conversationId);
    if (call) call.endRequested = true;
    return Boolean(call);
  }

  beginResponse(conversationId: string): CallMode | null {
    const call = this.calls.get(conversationId);
    if (!call) return null;
    call.endRequested = false;
    return call.mode;
  }

  /**
   * A response finished. end_call ends the call in either mode. In a short
   * call, a successful reply that declared itself `done` ends it; a reply
   * waiting for the user, or without a declared state, keeps it open.
   */
  finishResponse(conversationId: string, marker: 'listen' | 'done' | null): void {
    const call = this.calls.get(conversationId);
    if (!call) return;
    const ends = call.endRequested || (marker === 'done' && call.mode === 'short');
    call.next = ends ? 'end' : 'listen';
  }

  announceUpdate(conversationId: string, updateId: string): boolean {
    const call = this.calls.get(conversationId);
    if (!call || call.channels.size === 0) return false;
    call.updates.add(updateId);
    for (const send of call.channels) send({ type: 'update', id: updateId });
    return true;
  }

  takeUpdate(conversationId: string, updateId: string): boolean {
    return this.calls.get(conversationId)?.updates.delete(updateId) ?? false;
  }

  end(conversationId: string): void {
    const call = this.calls.get(conversationId);
    if (!call) return;
    call.closeTimer?.cancel();
    this.calls.delete(conversationId);
    const pending = [...call.updates];
    for (const listener of [...this.listeners]) listener(conversationId, pending);
  }

  onEnded(listener: CallEndListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  newVoiceInput(conversationId: string, callId: string | null, messages: unknown[]): VoiceUtterance | null {
    const entries = trailingUserEntries(messages);
    const fresh = entries.filter(
      (entry) => !this.voiceInputs.accepted(conversationId, callId, entry.identity)
    );
    if (fresh.length === 0) return null;
    return {
      text: fresh.map((entry) => entry.text).join('\n'),
      clientMessageId: entries.at(-1)?.identity ?? null,
      identities: entries.flatMap((entry) => (entry.identity ? [entry.identity] : [])),
    };
  }

  acceptVoiceInput(conversationId: string, callId: string | null, identities: string[]): void {
    for (const identity of identities) this.voiceInputs.remember(conversationId, callId, identity);
  }

  rejectVoiceInput(conversationId: string, callId: string | null, identities: string[]): void {
    for (const identity of identities) this.voiceInputs.forget(conversationId, callId, identity);
  }
}

export function createCallSessions(clock: Clock = systemClock): CallSessions {
  return new LocalCallSessions(clock);
}
