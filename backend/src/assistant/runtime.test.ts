import type { LettaCodeSession } from '@letta-ai/letta-agent-sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationEvent } from '../chat-types';
import { SessionReader, waitUntilIdle } from './runtime.ts';
import { withAbort } from './runtime/session-adapter.ts';

test('cancellation ends a reader turn even if the provider never sends a terminal result', async () => {
  const controller = new AbortController();
  const streaming = {
    async *stream() {
      await new Promise(() => {});
    },
  } as unknown as LettaCodeSession;
  const reader = new SessionReader(streaming, 'stuck-conversation');
  const turn = reader.nextTurn(controller.signal)[Symbol.asyncIterator]();
  const waiting = turn.next();
  controller.abort();
  const result = await waiting;
  assert.equal(result.value?.type, 'result');
  assert.equal(result.value?.error, 'aborted');
  assert.equal((await turn.next()).done, true);
});

test('cancellation releases a local wait when provider send does not settle', async () => {
  const controller = new AbortController();
  const waiting = withAbort(new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(waiting, /aborted/);
});

function session(getDeviceStatus: () => Promise<{ isProcessing: boolean }>): LettaCodeSession {
  return { getDeviceStatus } as unknown as LettaCodeSession;
}

test('waitUntilIdle returns when the session is idle', async () => {
  await waitUntilIdle(
    session(async () => ({ isProcessing: false })),
    100
  );
});

test('waitUntilIdle distinguishes an unreachable status endpoint', async () => {
  await assert.rejects(
    waitUntilIdle(
      session(async () => {
        throw new Error('socket closed');
      }),
      100
    ),
    /conversation status unreachable: socket closed/
  );
});

test('waitUntilIdle rejects a session that remains busy at the deadline', async () => {
  await assert.rejects(
    waitUntilIdle(
      session(async () => ({ isProcessing: true })),
      20
    ),
    /conversation busy: idle wait deadline exceeded/
  );
});

test('waitUntilIdle deadline bounds a status request that never settles', async () => {
  await assert.rejects(
    waitUntilIdle(
      session(() => new Promise(() => {})),
      20
    ),
    /conversation busy: idle wait deadline exceeded/
  );
});

test('waitUntilIdle honors cancellation while polling', async () => {
  const controller = new AbortController();
  const promise = waitUntilIdle(
    session(async () => ({ isProcessing: true })),
    1_000,
    controller.signal
  );
  controller.abort();
  await assert.rejects(promise, /aborted while waiting for conversation/);
});

test('SessionReader retains a terminal signal when the stream ends before a turn starts', async () => {
  const closed = {
    async *stream() {
      throw new Error('stream dropped');
    },
  } as unknown as LettaCodeSession;
  const reader = new SessionReader(closed, 'conversation-test');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const messages: unknown[] = [];
  for await (const message of reader.nextTurn()) messages.push(message);
  assert.deepEqual(messages, [{ type: 'result', success: false, errorCode: 'stream_closed' }]);
});

test('SessionReader forwards native follow-up output and does not duplicate an app-owned turn', async () => {
  const events: ConversationEvent[] = [];
  let release!: () => void;
  let done = false;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const streaming = {
    async *stream() {
      if (done) return;
      done = true;
      await ready;
      yield { type: 'assistant', uuid: 'native-reply', content: 'Worker finished.' };
      yield { type: 'result', success: true };
    },
  } as unknown as LettaCodeSession;
  new SessionReader(streaming, 'native-chat', {
    receiveNotifications: async () => 0,
    publish: (_id, event) => events.push(event),
  });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn_start', 'assistant_delta', 'turn_end', 'updates_changed']
  );

  let releaseOwned!: () => void;
  const ownedReady = new Promise<void>((resolve) => {
    releaseOwned = resolve;
  });
  let ownedDone = false;
  const owned = new SessionReader(
    {
      async *stream() {
        if (ownedDone) return;
        ownedDone = true;
        await ownedReady;
        yield { type: 'assistant', uuid: 'owned-reply', content: 'Normal answer.' };
        yield { type: 'result', success: true };
      },
    } as unknown as LettaCodeSession,
    'owned-chat',
    {
      receiveNotifications: async () => 0,
      publish: (_id, event) => events.push(event),
    }
  );
  const received = [];
  const messages = owned.nextTurn();
  releaseOwned();
  for await (const message of messages) received.push(message.type);
  assert.deepEqual(received, ['assistant', 'result']);
  assert.equal(events.length, 4);
});

test('SessionReader fails an oversized turn instead of retaining an unbounded buffer', async () => {
  let done = false;
  const streaming = {
    async *stream() {
      if (done) return;
      done = true;
      for (let i = 0; i < 600; i++) yield { type: 'reasoning', content: 'x', uuid: String(i) };
    },
  } as unknown as LettaCodeSession;
  const reader = new SessionReader(streaming, 'conversation-test');
  const iterator = reader.nextTurn()[Symbol.asyncIterator]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const overflow = await iterator.next();
  assert.equal((overflow.value as { error?: string }).error, 'session reader buffer limit reached');
});

test('reader routes a native follow-up even before the completed app turn is consumed', async () => {
  const events: ConversationEvent[] = [];
  let release!: () => void;
  let done = false;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = new SessionReader(
    {
      async *stream() {
        if (done) return;
        done = true;
        await ready;
        yield { type: 'assistant', uuid: 'app-answer', content: 'Initial answer' };
        yield { type: 'result', success: true };
        yield { type: 'assistant', uuid: 'native-answer', content: 'Worker complete' };
        yield { type: 'loop_status', status: 'WAITING_ON_INPUT', activeRunIds: [] };
        await new Promise(() => {});
      },
    } as unknown as LettaCodeSession,
    'boundary-chat',
    {
      receiveNotifications: async () => 0,
      publish: (_id, event) => events.push(event),
    }
  );
  const app = reader.nextTurn();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  const received: string[] = [];
  for await (const message of app) received.push(message.type);
  assert.deepEqual(received, ['assistant', 'result']);
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn_start', 'assistant_delta', 'turn_end', 'updates_changed']
  );
  assert.equal(reader.nativeTurnActive, false);
});
