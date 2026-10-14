import type { LettaCodeSession } from '@letta-ai/letta-agent-sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionReader, waitUntilIdle } from './runtime.ts';

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
