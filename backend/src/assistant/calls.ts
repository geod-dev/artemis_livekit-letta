import type { CallMode } from '../chat-types';
import type { ResponseState } from './messages';

/**
 * Live voice calls, one per conversation. A call is active while the voice
 * agent keeps its control channel open (`/api/voice/conversations/:id/call`).
 *
 * The interaction state lives here: the conversation mode (short calls end
 * after the final response has played; long calls stay open until ended), an
 * end requested by the assistant's tools, and whether the latest response
 * waits for the user (its `[listen]`/`[done]` marker). The voice agent owns the
 * audio timing and asks for the decision once a response has finished playing.
 */

export type CallEvent = { type: 'update'; id: string };

export interface CallState {
  mode: CallMode;
  /** What happens once the latest response has finished playing. */
  next: 'end' | 'listen';
}

interface Call extends CallState {
  conversationId: string;
  /** Requested by the end_call tool during the response being generated. */
  endRequested: boolean;
  channels: Set<(event: CallEvent) => void>;
  /** Spoken updates announced to the voice agent and not yet acknowledged. */
  updates: Set<string>;
  closeTimer?: NodeJS.Timeout;
}

/** A dropped control channel ends the call unless the agent reconnects in time. */
const RECONNECT_GRACE_MS = 10_000;

const calls = new Map<string, Call>();
const endListeners = new Map<string, (conversationId: string, pendingUpdates: string[]) => void>();

/** The active call of a conversation, if any. */
export function activeCall(conversationId: string): CallState | null {
  const call = calls.get(conversationId);
  return call ? { mode: call.mode, next: call.next } : null;
}

/**
 * The voice agent opened its control channel. A new call starts in `mode`; a
 * reconnecting agent keeps the call's current mode. Returns the function that
 * closes the channel.
 */
export function openCallChannel(
  conversationId: string,
  send: (event: CallEvent) => void,
  mode: CallMode = 'short'
): () => void {
  let call = calls.get(conversationId);
  if (!call) {
    call = {
      conversationId,
      mode,
      next: 'listen',
      endRequested: false,
      channels: new Set(),
      updates: new Set(),
    };
    calls.set(conversationId, call);
  }
  clearTimeout(call.closeTimer);
  call.channels.add(send);
  // Announce updates again: a reconnecting agent lost its queue.
  for (const id of call.updates) send({ type: 'update', id });

  const opened = call;
  return () => {
    opened.channels.delete(send);
    if (opened.channels.size > 0 || calls.get(conversationId) !== opened) return;
    opened.closeTimer = setTimeout(() => endCall(conversationId), RECONNECT_GRACE_MS).unref();
  };
}

/** The call is over. Listeners receive the updates that were never acknowledged. */
export function endCall(conversationId: string): void {
  const call = calls.get(conversationId);
  if (!call) return;
  clearTimeout(call.closeTimer);
  calls.delete(conversationId);
  const pending = [...call.updates];
  for (const listener of endListeners.values()) listener(conversationId, pending);
}

/** Register the listener for ended calls under a key (re-registering replaces it). */
export function onCallEnded(
  key: string,
  listener: (conversationId: string, pendingUpdates: string[]) => void
): void {
  endListeners.set(key, listener);
}

/** A response in the call starts: the mode it runs in, and a fresh end request. */
export function beginCallResponse(conversationId: string): CallMode | null {
  const call = calls.get(conversationId);
  if (!call) return null;
  call.endRequested = false;
  return call.mode;
}

/**
 * A response in the call finished. end_call ends the call in either mode. In a
 * short call, a reply to the user ends it when the reply declared itself done;
 * a reply waiting for the user, or without a declared state, keeps it open.
 * Spoken updates never end it on their own, and a failed reply keeps it open
 * so the user can retry.
 */
export function finishCallResponse(
  conversationId: string,
  outcome: { reply: boolean; success: boolean; state: ResponseState | null }
): void {
  const call = calls.get(conversationId);
  if (!call) return;
  const ends =
    call.endRequested ||
    (outcome.reply && outcome.success && call.mode === 'short' && outcome.state === 'done');
  call.next = ends ? 'end' : 'listen';
}

export function callState(conversationId: string): CallState {
  return activeCall(conversationId) ?? { mode: 'short', next: 'listen' };
}

/** Effects of the call tools. Each returns false when the conversation has no active call. */
export const callControls = {
  setMode(conversationId: string, mode: CallMode): boolean {
    const call = calls.get(conversationId);
    if (call) call.mode = mode;
    return Boolean(call);
  },
  end(conversationId: string): boolean {
    const call = calls.get(conversationId);
    if (call) call.endRequested = true;
    return Boolean(call);
  },
};

/** Announce a spoken update to the voice agent. False when no call can take it. */
export function announceUpdate(conversationId: string, id: string): boolean {
  const call = calls.get(conversationId);
  if (!call || call.channels.size === 0) return false;
  call.updates.add(id);
  for (const send of call.channels) send({ type: 'update', id });
  return true;
}

/**
 * The voice agent starts speaking an update: it leaves the pending set, so it
 * is generated once and an ending call does not deliver it again. False when
 * the update is not pending in an active call.
 */
export function takeUpdate(conversationId: string, id: string): boolean {
  return calls.get(conversationId)?.updates.delete(id) ?? false;
}
