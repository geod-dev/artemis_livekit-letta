import assert from 'node:assert/strict';
import test from 'node:test';
import { isConversationEvent } from './conversation-protocol.ts';

test('accepts snapshot state and a user echo with its client identity', () => {
  assert.equal(
    isConversationEvent({
      type: 'snapshot',
      turns: [{ turnId: 'turn-1', modality: 'text' }],
      tasks: [{ taskId: 'task-1', status: 'running', title: 'Working' }],
      activeEvents: [
        { type: 'turn_start', turnId: 'turn-1', modality: 'text' },
        {
          type: 'assistant_delta',
          turnId: 'turn-1',
          messageId: 'assistant-1',
          text: 'partial reply',
        },
      ],
    }),
    true
  );
  assert.equal(
    isConversationEvent({
      type: 'message',
      turnId: 'turn-1',
      message: {
        id: 'row-1',
        role: 'user',
        text: 'hello',
        modality: 'text',
        clientMessageId: 'client-1',
      },
    }),
    true
  );
});

test('rejects malformed, unknown, or incomplete SSE events', () => {
  assert.equal(isConversationEvent({ type: 'snapshot', turns: [], tasks: 'bad' }), false);
  assert.equal(
    isConversationEvent({ type: 'message', turnId: 'turn-1', message: { role: 'user' } }),
    false
  );
  assert.equal(isConversationEvent({ type: 'new_event_from_server' }), false);
  assert.equal(
    isConversationEvent({
      type: 'snapshot',
      turns: [],
      tasks: [],
      activeEvents: [{ type: 'snapshot', turns: [], tasks: [], activeEvents: [] }],
    }),
    false
  );
  assert.equal(
    isConversationEvent({
      type: 'message',
      turnId: 'turn-1',
      message: {
        id: 'row-1',
        role: 'user',
        text: 'hello',
        modality: 'text',
        clientMessageId: 'x'.repeat(201),
      },
    }),
    false
  );
});
