import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationEvent } from '../../chat-types';
import { NativeTurn } from './native-turn';

test('autonomous replies emit a complete live turn with stable message identities', async () => {
  const events: ConversationEvent[] = [];
  const native = new NativeTurn((event) => events.push(event));
  await native.accept({ type: 'queue_update', queue: [] } as unknown as SDKMessage);
  assert.equal(events.length, 0);
  await native.accept({ type: 'reasoning', uuid: 'reasoning-1', content: 'Check the report' });
  assert.equal(native.active, true);
  await native.accept({ type: 'assistant', uuid: 'answer-1', content: 'The result is ' });
  await native.accept({ type: 'assistant', uuid: 'answer-1', content: '42.' });
  await native.accept({ type: 'result', success: true } as SDKMessage);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'turn_start',
      'reasoning_delta',
      'assistant_delta',
      'assistant_delta',
      'turn_end',
      'updates_changed',
    ]
  );
  const start = events[0];
  assert.equal(start.type, 'turn_start');
  for (const event of events.slice(1, -1)) {
    assert.ok('turnId' in event && 'turnId' in start && event.turnId === start.turnId);
  }
  assert.equal(native.active, false);
});

test('native tools retain streamed arguments and observe work before publishing its result', async () => {
  const events: ConversationEvent[] = [];
  const observed: unknown[] = [];
  const native = new NativeTurn(
    (event) => events.push(event),
    async (call, result) => {
      assert.equal(
        events.some((event) => event.type === 'tool_result'),
        false
      );
      observed.push({ call, result });
    }
  );
  for (const rawArguments of ['{"prompt":', '"research"}']) {
    await native.accept({
      type: 'tool_call',
      toolCallId: 'call-1',
      toolName: 'Agent',
      toolInput: {},
      rawArguments,
      uuid: 'tool-1',
    });
  }
  await native.accept({
    type: 'tool_result',
    toolCallId: 'call-1',
    content: 'Task running in background with task ID: task_2',
    isError: false,
    uuid: 'tool-2',
  });
  assert.equal(events.filter((event) => event.type === 'tool_call').length, 1);
  assert.deepEqual(observed, [
    {
      call: { name: 'Agent', args: '{"prompt":"research"}' },
      result: {
        type: 'tool_result',
        toolCallId: 'call-1',
        content: 'Task running in background with task ID: task_2',
        isError: false,
        uuid: 'tool-2',
      },
    },
  ]);
  native.finish(false, 'stream_closed');
  assert.deepEqual(events.at(-1), {
    type: 'turn_end',
    turnId: (events[0] as { turnId: string }).turnId,
    success: false,
    error: 'stream_closed',
  });
});

test('cancelled notification-only turns refresh history without creating empty answers', async () => {
  const events: ConversationEvent[] = [];
  const native = new NativeTurn((event) => events.push(event));
  await native.accept({ type: 'result', success: false, errorCode: 'interrupted' } as SDKMessage);
  assert.deepEqual(events, [{ type: 'updates_changed' }]);
  native.finish(false, 'stream_closed');
  assert.equal(events.length, 1);
});

test('SDK autonomous replies settle on idle loop status without a synthetic result', async () => {
  const events: ConversationEvent[] = [];
  const native = new NativeTurn((event) => events.push(event));
  const idle: SDKMessage = { type: 'loop_status', status: 'WAITING_ON_INPUT', activeRunIds: [] };
  await native.accept(idle);
  assert.equal(events.length, 0);
  for (const id of ['first-worker-answer', 'second-worker-answer']) {
    await native.accept({ type: 'assistant', uuid: id, content: id });
    await native.accept({ type: 'loop_status', status: 'RUNNING', activeRunIds: [id] });
    assert.equal(native.active, true);
    await native.accept(idle);
    assert.equal(native.active, false);
    await native.accept(idle);
  }
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'turn_start',
      'assistant_delta',
      'turn_end',
      'updates_changed',
      'turn_start',
      'assistant_delta',
      'turn_end',
      'updates_changed',
    ]
  );
  const ends = events.filter((event) => event.type === 'turn_end');
  assert.ok(ends.every((event) => event.success));
  assert.notEqual(ends[0].turnId, ends[1].turnId);
});

test('autonomous idle completion preserves the provider error', async () => {
  const events: ConversationEvent[] = [];
  const native = new NativeTurn((event) => events.push(event));
  await native.accept({ type: 'assistant', uuid: 'failed', content: 'Partial answer' });
  await native.accept({ type: 'error', message: 'provider failed' } as SDKMessage);
  await native.accept({ type: 'loop_status', status: 'WAITING_ON_INPUT', activeRunIds: [] });
  assert.equal(native.active, false);
  assert.deepEqual(events.at(-2), {
    type: 'turn_end',
    turnId: (events[0] as { turnId: string }).turnId,
    success: false,
    error: 'provider failed',
  });
});
