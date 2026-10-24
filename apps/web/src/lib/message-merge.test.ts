import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '@artemis/contracts/chat-types';
import type { LiveConversationItem } from './conversation-state.ts';
import {
  addLiveMessage,
  addLiveToolCall,
  appendLiveDelta,
  applyLiveToolResult,
  settleTurnLive,
} from './message-merge.ts';

const answer = (id: string, text: string): ChatMessage =>
  ({ id, role: 'assistant', text }) as ChatMessage;

test('a streamed message is kept once, even when the stream replays it', () => {
  const once = addLiveMessage([], 't1', answer('m1', 'hi'));
  assert.equal(once.length, 1);
  assert.equal(addLiveMessage(once, 't1', answer('m1', 'hi')), once);
});

test('deltas append to their message, and reasoning has its own prefixed id', () => {
  let items: LiveConversationItem[] = [];
  items = appendLiveDelta(items, {
    type: 'assistant_delta',
    turnId: 't1',
    messageId: 'm1',
    text: 'Hel',
  } as never);
  items = appendLiveDelta(items, {
    type: 'assistant_delta',
    turnId: 't1',
    messageId: 'm1',
    text: 'lo',
  } as never);
  items = appendLiveDelta(items, {
    type: 'reasoning_delta',
    turnId: 't1',
    messageId: 'm1',
    text: 'think',
  } as never);
  assert.deepEqual(
    items.map((item) => item.message),
    [
      { id: 'm1', role: 'assistant', text: 'Hello' },
      { id: 'reasoning:m1', role: 'reasoning', text: 'think' },
    ]
  );
});

test('a tool result fills in its call row', () => {
  const called = addLiveToolCall([], {
    type: 'tool_call',
    turnId: 't1',
    toolCallId: 'c1',
    name: 'bash',
  } as never);
  const done = applyLiveToolResult(called, {
    type: 'tool_result',
    turnId: 't1',
    toolCallId: 'c1',
    result: 'ok',
    isError: false,
  } as never);
  assert.deepEqual(done[0]?.message, {
    id: 'c1',
    role: 'tool',
    toolCallId: 'c1',
    name: 'bash',
    args: undefined,
    result: 'ok',
    isError: false,
    display: undefined,
    task: undefined,
  });
});

test('a finished turn drops its streamed rows that history now holds, and keeps the rest', () => {
  const items: LiveConversationItem[] = [
    { turnId: 't1', message: answer('m1', 'Hello there') },
    { turnId: 't2', message: answer('m2', 'other turn') },
  ];
  // History holds the full text of m1, so its streamed copy goes; m2 belongs to another turn.
  assert.deepEqual(settleTurnLive(items, 't1', [answer('m1', 'Hello there')]), [items[1]]);
  // A stream still ahead of history keeps its answer until history catches up.
  assert.deepEqual(settleTurnLive(items, 't1', [answer('m1', 'Hel')]), items);
});
