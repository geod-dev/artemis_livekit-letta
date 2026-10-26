import type {
  ChatMessage,
  ConversationEvent,
  ConversationSummary,
} from '@artemis/contracts/chat-types';
import type { fetchHistory, openConversationStream } from './conversation-client.ts';
import type {
  ConversationStateAction,
  LiveConversationItem,
  RunningTask,
} from './conversation-state.ts';
import {
  addLiveMessage,
  addLiveToolCall,
  appendLiveDelta,
  applyLiveToolResult,
  settleTurnLive,
} from './message-merge.ts';
import {
  applyTaskEvent,
  endTurn,
  snapshotTasks,
  snapshotTurnIds,
  startTurn,
} from './turn-state.ts';

/** A state update as React's setters take it: a value, or a function of the previous one. */
type StateUpdate<T> = T | ((previous: T) => T);

/** Resolves once the event stream of a conversation has opened (see createReadyGate). */
interface ReadyGate {
  readonly promise: Promise<void>;
  resolve(): void;
  readonly settled: boolean;
}

export function createReadyGate(): ReadyGate {
  let resolve!: () => void;
  let settled = false;
  const promise = new Promise<void>((done) => {
    resolve = () => {
      settled = true;
      done();
    };
  });
  return {
    promise,
    resolve,
    get settled() {
      return settled;
    },
  };
}

/** The stream a send waits for: the conversation it is open for, and when it is ready. */
export interface StreamConnection {
  readonly id: string | null;
  readonly ready: Promise<void>;
}

export const CONNECT_ERROR = 'Could not connect to the conversation stream. Try sending again.';

/** Stream failures in a row before the user is told the live updates are down. */
const OUTAGE_FAILURES = 3;

/**
 * Waits until the stream of `id` is open and its gate has resolved. Resolves false when
 * the user switched to another conversation meanwhile (the send is dropped), and rejects
 * with the connect error when the stream does not open within `timeoutMs`.
 */
export async function awaitStreamReady(
  id: string,
  stream: { connection(): StreamConnection; requested(): string | null },
  timeoutMs = 15_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (stream.connection().id !== id) {
    if (stream.requested() !== id) return false;
    if (Date.now() >= deadline) throw new Error(CONNECT_ERROR);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const remaining = Math.max(0, deadline - Date.now());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(CONNECT_ERROR)), remaining);
    stream.connection().ready.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
  return true;
}

/** The state a stream event changes, and the refs and history work it depends on. */
export interface ConversationEventDeps {
  /** A message waiting on screen for its server echo, if any (its truthiness is all that is read). */
  readonly pending: { current: unknown };
  /** The client identity the pending message was sent with. */
  readonly pendingClientId: { current: string | null };
  /** The user pressed stop and the turn has not ended yet. */
  readonly stopRequested: { current: boolean };
  setError(message: string | null): void;
  setPending(value: null): void;
  setLive(update: StateUpdate<LiveConversationItem[]>): void;
  setActiveTurns(update: StateUpdate<string[]>): void;
  setTasks(update: StateUpdate<RunningTask[]>): void;
  setSettledTurns(update: StateUpdate<number>): void;
  bumpContextUsage(): void;
  /** Re-reads the history; a finished turn swaps its streamed items for the persisted rows. */
  reconcileHistory(turnId?: string, stoppedByUser?: boolean, started?: boolean): void;
  conversationUpdated(conversation: ConversationSummary): void;
}

/**
 * Applies the events of one conversation's stream to its state, in order. A failure to
 * apply an event is reported, and the history is re-read. Per-stream bookkeeping (which
 * turns this stream started or settled) lives in the returned router, so one router serves
 * one subscription.
 */
export function createConversationEventRouter(
  deps: ConversationEventDeps
): (event: ConversationEvent) => void {
  /** Turns that sent their message through this stream (read before the state catches up). */
  const startedTurns = new Set<string>();
  const settledTurnIds = new Set<string>();

  function handle(event: ConversationEvent): void {
    switch (event.type) {
      case 'context_usage':
        deps.bumpContextUsage();
        break;
      case 'snapshot':
        event.turns.forEach((turn) => startedTurns.add(turn.turnId));
        deps.setActiveTurns(snapshotTurnIds(event.turns));
        deps.setTasks(snapshotTasks(event.tasks));
        event.activeEvents.forEach(applyEvent);
        break;
      case 'turn_start':
        startedTurns.add(event.turnId);
        deps.setError(null);
        deps.setActiveTurns((turns) => startTurn(turns, event.turnId));
        break;
      case 'message': {
        // Match the optimistic row by the server echoed client identity, then
        // keep the server's canonical message ID for history reconciliation.
        const isEcho = Boolean(
          deps.pending.current &&
          event.message.role === 'user' &&
          event.message.clientMessageId &&
          event.message.clientMessageId === deps.pendingClientId.current
        );
        if (isEcho) {
          deps.pendingClientId.current = null;
          deps.setPending(null);
        }
        const message = event.message;
        deps.setLive((items) => addLiveMessage(items, event.turnId, message));
        break;
      }
      case 'assistant_delta':
      case 'reasoning_delta':
        deps.setLive((items) => appendLiveDelta(items, event));
        break;
      case 'tool_call':
        deps.setLive((items) => addLiveToolCall(items, event));
        break;
      case 'tool_result':
        deps.setLive((items) => applyLiveToolResult(items, event));
        break;
      case 'turn_end': {
        if (!event.success && event.error && event.error !== 'aborted') deps.setError(event.error);
        const started = startedTurns.delete(event.turnId);
        if (!settledTurnIds.has(event.turnId)) {
          settledTurnIds.add(event.turnId);
          deps.setActiveTurns((turns) => endTurn(turns, event.turnId));
          deps.setSettledTurns((n) => n + 1);
        }
        // Failed or stopped before it started: its message was never sent.
        if (!started && deps.pendingClientId.current) {
          deps.pendingClientId.current = null;
          deps.setPending(null);
        }
        const stoppedByUser = event.error === 'aborted' && deps.stopRequested.current;
        if (stoppedByUser) deps.stopRequested.current = false;
        deps.reconcileHistory(event.turnId, stoppedByUser, started);
        break;
      }
      case 'task':
        deps.setTasks((tasks) => applyTaskEvent(tasks, event));
        break;
      case 'updates_changed':
        // Completion notices can arrive during an autonomous turn.
        // Refresh history without discarding its streamed response.
        deps.reconcileHistory();
        break;
      case 'conversation_updated':
        deps.conversationUpdated(event.conversation);
        break;
    }
  }

  /** Applies one event; a failure is reported and the history re-read. */
  function applyEvent(event: ConversationEvent): void {
    try {
      handle(event);
    } catch {
      deps.setError('Could not apply a conversation update; refreshing…');
      deps.reconcileHistory();
    }
  }

  return applyEvent;
}

/** What a subscription reads and writes: the event state, its connection holder, and the client calls. */
interface SubscriptionDeps extends Omit<ConversationEventDeps, 'reconcileHistory'> {
  /** The stream the sends wait for; updated as the subscription opens, reconnects and closes. */
  readonly connected: { current: StreamConnection & { id: string | null } };
  setStopped(update: StateUpdate<ReadonlySet<string>>): void;
  /** Puts a conversation's rows on screen: the first time it is shown, and on each switch to it. */
  activate(rows: ChatMessage[]): void;
  dispatch(action: ConversationStateAction): void;
  fetchHistory: typeof fetchHistory;
  openStream: typeof openConversationStream;
}

/**
 * Keeps one conversation on screen and in sync: loads its history, opens its event stream
 * and applies the events in order. Events that arrive before the history is on screen wait
 * for it. Returns the function that closes the stream when the conversation is left.
 */
export function subscribeToConversation(
  conversationId: string,
  isFresh: boolean,
  deps: SubscriptionDeps
): () => void {
  let cancelled = false;
  let historyRevision = 0;
  let hasShown = false;
  /** Events wait until the history is on screen, then replay in order. */
  let backlog: ConversationEvent[] | null = [];

  const reconcileHistory = async (turnId?: string, stoppedByUser = false, started = false) => {
    const revision = ++historyRevision;
    deps.dispatch({ type: 'history-requested', conversationId, revision });
    const rows = await deps.fetchHistory(conversationId);
    if (cancelled || revision !== historyRevision) return false;
    if (!rows) {
      deps.dispatch({
        type: 'history-failed',
        conversationId,
        revision,
        message: 'Could not refresh this conversation',
      });
      return false;
    }
    if (!hasShown) ready(rows);
    deps.dispatch({ type: 'history-loaded', conversationId, revision, history: rows });
    if (turnId) {
      deps.setLive((items) => settleTurnLive(items, turnId, rows));
      if (stoppedByUser && started) {
        const last = rows.at(-1);
        if (last) deps.setStopped((ids) => new Set(ids).add(last.id));
      }
    }
    return true;
  };
  const applyEvent = createConversationEventRouter({ ...deps, reconcileHistory });
  const ready = (rows: ChatMessage[]) => {
    if (cancelled) return;
    hasShown = true;
    deps.activate(rows);
    const held = backlog ?? [];
    backlog = null;
    held.forEach(applyEvent);
  };
  if (isFresh) {
    ready([]);
  } else {
    const revision = ++historyRevision;
    void deps.fetchHistory(conversationId).then((rows) => {
      if (revision !== historyRevision) return;
      ready(rows ?? []);
      if (!rows && !cancelled) {
        deps.dispatch({
          type: 'history-failed',
          conversationId,
          revision,
          message: 'Could not load this conversation',
        });
      }
    });
  }

  let gate = createReadyGate();
  /** Failures since the stream last opened, and whether the outage has been reported. */
  let failuresSinceOpen = 0;
  let outageShown = false;
  const closeStream = deps.openStream(conversationId, {
    // A subscription is only ready after each successful open, including retries.
    onOpen: () => {
      failuresSinceOpen = 0;
      if (outageShown) {
        outageShown = false;
        deps.setError(null);
      }
      deps.bumpContextUsage();
      gate.resolve();
      deps.connected.current = { id: conversationId, ready: Promise.resolve() };
      deps.setLive([]);
      deps.setActiveTurns([]);
      deps.setTasks([]);
      void reconcileHistory();
    },
    onError: () => {
      // The stream reopens itself (see openConversationStream). Keep sends waiting for the next open.
      if (deps.connected.current.id === conversationId && gate.settled) {
        gate = createReadyGate();
        deps.connected.current = { id: conversationId, ready: gate.promise };
      }
      failuresSinceOpen += 1;
      if (failuresSinceOpen >= OUTAGE_FAILURES && !outageShown) {
        outageShown = true;
        deps.setError('Live updates are unavailable. Reconnecting…');
      }
    },
    onEvent: (event) => {
      if (backlog) backlog.push(event);
      else applyEvent(event);
    },
    onRejected: (reason) => {
      deps.setError(
        reason === 'oversized'
          ? 'Received an oversized conversation update; refreshing…'
          : reason === 'invalid'
            ? 'Received an invalid conversation update; refreshing…'
            : 'Received an unsupported conversation update; refreshing…'
      );
      void reconcileHistory();
    },
  });
  deps.connected.current = { id: conversationId, ready: gate.promise };

  return () => {
    cancelled = true;
    gate.resolve();
    if (deps.connected.current.id === conversationId)
      deps.connected.current = { id: null, ready: Promise.resolve() };
    closeStream();
  };
}
