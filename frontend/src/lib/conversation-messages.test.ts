import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '@shared/chat-types';
import { historyCoversMessage, mergeConversationMessages } from './conversation-messages.ts';

test('refreshing a completion notice while the assistant streams retains the complete live response', () => {
  const partial: ChatMessage = { id: 'answer', role: 'assistant', text: 'The result is ' };
  const streamed: ChatMessage = { ...partial, text: 'The result is 42.' };
  const notice: ChatMessage = {
    id: 'notice',
    role: 'event',
    kind: 'task_result',
    updateId: 'update-1',
    text: 'Worker',
    durationMs: 20000,
  };
  assert.deepEqual(
    mergeConversationMessages([notice, partial], [{ turnId: 'native', message: streamed }], null),
    [notice, streamed]
  );
  assert.equal(historyCoversMessage(partial, streamed), false);
  assert.equal(historyCoversMessage(streamed, streamed), true);
});

test('persisted notices replace streamed notices by update identity without moving the response', () => {
  const persisted: ChatMessage = {
    id: 'stored-notice',
    role: 'event',
    kind: 'task_result',
    updateId: 'update-1',
    text: 'Worker',
    durationMs: 92000,
  };
  const response: ChatMessage = { id: 'answer', role: 'assistant', text: '42.' };
  assert.deepEqual(
    mergeConversationMessages(
      [persisted],
      [
        { turnId: 'turn-1', message: { ...persisted, id: 'streamed-notice' } },
        { turnId: 'turn-1', message: response },
      ],
      null
    ),
    [persisted, response]
  );
});
