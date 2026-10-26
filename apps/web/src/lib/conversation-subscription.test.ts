import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { ConversationEvent } from '@artemis/contracts/chat-types';
import { openConversationStream } from './conversation-client.ts';
import {
  CONNECT_ERROR,
  type ConversationEventDeps,
  type StreamConnection,
  awaitStreamReady,
  createConversationEventRouter,
  createReadyGate,
  subscribeToConversation,
} from './conversation-subscription.ts';

/** A stand-in for the hook's state: updaters are applied to plain values, as React would. */
function fakeDeps() {
  const store = {
    error: null as string | null,
    pending: null as unknown,
    live: [] as unknown[],
    activeTurns: [] as string[],
    tasks: [] as unknown[],
    settledTurns: 0,
    contextBumps: 0,
    updated: [] as unknown[],
    reconciles: [] as unknown[][],
  };
  const apply = <T>(current: T, update: T | ((previous: T) => T)): T =>
    typeof update === 'function' ? (update as (previous: T) => T)(current) : update;
  const deps: ConversationEventDeps = {
    pending: { current: null },
    pendingClientId: { current: null },
    stopRequested: { current: false },
    setError: (message) => {
      store.error = message;
    },
    setPending: (value) => {
      store.pending = value;
    },
    setLive: (update) => {
      store.live = apply(store.live as never, update as never) as unknown[];
    },
    setActiveTurns: (update) => {
      store.activeTurns = apply(store.activeTurns, update);
    },
    setTasks: (update) => {
      store.tasks = apply(store.tasks as never, update as never) as unknown[];
    },
    setSettledTurns: (update) => {
      store.settledTurns = apply(store.settledTurns, update);
    },
    bumpContextUsage: () => {
      store.contextBumps += 1;
    },
    reconcileHistory: (...args) => {
      store.reconciles.push(args);
    },
    conversationUpdated: (conversation) => {
      store.updated.push(conversation);
    },
  };
  return { deps, store };
}

test('a ready gate settles once it is resolved', async () => {
  const gate = createReadyGate();
  assert.equal(gate.settled, false);
  gate.resolve();
  assert.equal(gate.settled, true);
  await gate.promise;
});

test('a send waits for its stream and goes ahead once it is ready', async () => {
  const ready = Promise.resolve();
  const connection: StreamConnection = { id: 'c1', ready };
  assert.equal(
    await awaitStreamReady('c1', { connection: () => connection, requested: () => 'c1' }),
    true
  );
});

test('a send is dropped when the user switched to another conversation meanwhile', async () => {
  assert.equal(
    await awaitStreamReady('c1', {
      connection: () => ({ id: null, ready: Promise.resolve() }),
      requested: () => 'c2',
    }),
    false
  );
});

test('a send fails with the connect error when the stream never opens', async () => {
  await assert.rejects(
    awaitStreamReady(
      'c1',
      { connection: () => ({ id: null, ready: Promise.resolve() }), requested: () => 'c1' },
      1
    ),
    { message: CONNECT_ERROR }
  );
});

test('an echoed message clears the pending row and keeps the server copy once', () => {
  const { deps, store } = fakeDeps();
  deps.pending.current = { text: 'hi' };
  deps.pendingClientId.current = 'client-1';
  const apply = createConversationEventRouter(deps);
  const event = {
    type: 'message',
    turnId: 't1',
    message: { id: 'm1', role: 'user', text: 'hi', clientMessageId: 'client-1' },
  } as unknown as ConversationEvent;
  apply(event);
  apply(event);
  assert.equal(store.pending, null);
  assert.equal(deps.pendingClientId.current, null);
  assert.equal(store.live.length, 1);
});

test('a turn is active from its start until its end, then history is re-read', () => {
  const { deps, store } = fakeDeps();
  const apply = createConversationEventRouter(deps);
  apply({ type: 'turn_start', turnId: 't1' } as ConversationEvent);
  assert.deepEqual(store.activeTurns, ['t1']);
  apply({ type: 'turn_end', turnId: 't1', success: true } as ConversationEvent);
  assert.deepEqual(store.activeTurns, []);
  assert.equal(store.settledTurns, 1);
  assert.deepEqual(store.reconciles, [['t1', false, true]]);
});

test('a turn stopped by the user is marked as stopped, and the stop is consumed', () => {
  const { deps, store } = fakeDeps();
  deps.stopRequested.current = true;
  const apply = createConversationEventRouter(deps);
  apply({ type: 'turn_start', turnId: 't1' } as ConversationEvent);
  apply({ type: 'turn_end', turnId: 't1', success: false, error: 'aborted' } as ConversationEvent);
  assert.equal(store.error, null);
  assert.deepEqual(store.reconciles, [['t1', true, true]]);
  assert.equal(deps.stopRequested.current, false);
});

test('an event that cannot be applied is reported and the history re-read', () => {
  const { deps, store } = fakeDeps();
  deps.setActiveTurns = () => {
    throw new Error('boom');
  };
  const apply = createConversationEventRouter(deps);
  apply({ type: 'turn_start', turnId: 't1' } as ConversationEvent);
  assert.equal(store.error, 'Could not apply a conversation update; refreshing…');
  assert.deepEqual(store.reconciles, [[]]);
});

test('context usage and conversation updates reach the hook', () => {
  const { deps, store } = fakeDeps();
  const apply = createConversationEventRouter(deps);
  apply({ type: 'context_usage' } as ConversationEvent);
  apply({ type: 'conversation_updated', conversation: { id: 'c1' } } as ConversationEvent);
  assert.equal(store.contextBumps, 1);
  assert.deepEqual(store.updated, [{ id: 'c1' }]);
});

test('a fresh conversation shows at once, then its stream loads history and applies events', async () => {
  type Handlers = Parameters<typeof openConversationStream>[1];
  const { deps, store } = fakeDeps();
  const shown: unknown[] = [];
  const actions: { type: string }[] = [];
  const connected = { current: { id: null as string | null, ready: Promise.resolve() } };
  let handlers: Handlers | undefined;
  let closed = false;
  const close = subscribeToConversation('c1', true, {
    ...deps,
    connected,
    setStopped: () => undefined,
    activate: (rows) => {
      shown.push(rows);
    },
    dispatch: (action) => {
      actions.push(action);
    },
    fetchHistory: async () => [],
    openStream: (_id, next) => {
      handlers = next;
      return () => {
        closed = true;
      };
    },
  });
  assert.deepEqual(shown, [[]]);

  handlers?.onOpen?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    actions.map((action) => action.type),
    ['history-requested', 'history-loaded']
  );
  assert.equal(connected.current.id, 'c1');
  assert.equal(store.contextBumps, 1);

  handlers?.onEvent?.({ type: 'turn_start', turnId: 't1' } as ConversationEvent);
  assert.deepEqual(store.activeTurns, ['t1']);

  close();
  assert.equal(closed, true);
  assert.equal(connected.current.id, null);
});

/** A stand-in for the browser's EventSource: the test drives its state and its events. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  private readonly openListeners: Array<() => void> = [];

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    if (type === 'open') this.openListeners.push(listener);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  /** The server answered: the stream is open. */
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.openListeners.forEach((listener) => listener());
  }

  /** The stream failed with the given state; a non-200 response leaves it CLOSED for good. */
  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }
}

test('reopens the stream after EventSource closes on a 502', () => {
  const original = Reflect.get(globalThis, 'EventSource');
  Reflect.set(globalThis, 'EventSource', FakeEventSource);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const connected = { current: { id: null as string | null, ready: Promise.resolve() } };
    const fetched: string[] = [];
    const close = subscribeToConversation('c1', true, {
      ...fakeDeps().deps,
      connected,
      setStopped: () => undefined,
      activate: () => undefined,
      dispatch: () => undefined,
      fetchHistory: async (id) => {
        fetched.push(id);
        return [];
      },
      openStream: openConversationStream,
    });
    FakeEventSource.instances[0]?.open();
    assert.equal(connected.current.id, 'c1');

    // The gateway restarted behind nginx: the request got a 502 and the stream is CLOSED.
    FakeEventSource.instances[0]?.fail(FakeEventSource.CLOSED);
    mock.timers.tick(1_000);
    assert.equal(FakeEventSource.instances.length, 2, 'the closed stream is opened again');

    FakeEventSource.instances[1]?.open();
    assert.equal(connected.current.id, 'c1');
    assert.deepEqual(fetched, ['c1', 'c1'], 'the history is re-read on each open, the reopen too');
    close();
    assert.equal(FakeEventSource.instances[1]?.readyState, FakeEventSource.CLOSED);
  } finally {
    mock.timers.reset();
    Reflect.set(globalThis, 'EventSource', original);
    FakeEventSource.instances = [];
  }
});
