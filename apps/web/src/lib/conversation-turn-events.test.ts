import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isConversationEvent } from './conversation-protocol.ts';

test('the events of a text turn (start, streamed deltas, end) are accepted', () => {
  const turn = [
    { type: 'turn_start', turnId: 'turn-1', modality: 'text' },
    { type: 'assistant_delta', turnId: 'turn-1', messageId: 'assistant-1:0', text: 'Hel' },
    { type: 'assistant_delta', turnId: 'turn-1', messageId: 'assistant-1:0', text: 'lo' },
    { type: 'turn_end', turnId: 'turn-1', success: true },
  ];
  for (const event of turn) {
    assert.equal(isConversationEvent(event), true, JSON.stringify(event));
  }
});

test('a failed turn end carries its error message and an aborted turn is accepted', () => {
  assert.equal(
    isConversationEvent({
      type: 'turn_end',
      turnId: 'turn-1',
      success: false,
      error: 'Model request failed',
    }),
    true
  );
  assert.equal(
    isConversationEvent({ type: 'turn_end', turnId: 'turn-1', success: false, error: 'aborted' }),
    true
  );
});

test('turn events without their required fields are rejected', () => {
  assert.equal(isConversationEvent({ type: 'turn_end', turnId: 'turn-1' }), false);
  assert.equal(
    isConversationEvent({ type: 'turn_end', turnId: 'turn-1', success: 'false' }),
    false
  );
  assert.equal(
    isConversationEvent({ type: 'turn_start', turnId: 'turn-1', modality: 'video' }),
    false
  );
  assert.equal(
    isConversationEvent({ type: 'assistant_delta', turnId: 'turn-1', text: 'Hi' }),
    false
  );
  assert.equal(
    isConversationEvent({ type: 'assistant_delta', turnId: 'turn-1', messageId: 'm', text: 1 }),
    false
  );
});

test('a snapshot restoring an in-flight turn and its streamed text is accepted', () => {
  assert.equal(
    isConversationEvent({
      type: 'snapshot',
      turns: [{ turnId: 'turn-1', modality: 'text' }],
      tasks: [],
      activeEvents: [
        { type: 'turn_start', turnId: 'turn-1', modality: 'text' },
        { type: 'assistant_delta', turnId: 'turn-1', messageId: 'assistant-1:0', text: 'partial' },
      ],
    }),
    true
  );
});

test('a snapshot with a turn of unknown modality is rejected', () => {
  assert.equal(
    isConversationEvent({
      type: 'snapshot',
      turns: [{ turnId: 'turn-1', modality: 'video' }],
      tasks: [],
      activeEvents: [],
    }),
    false
  );
});

test('tool, task, update and conversation events the hook handles are accepted', () => {
  const events = [
    { type: 'tool_call', turnId: 'turn-1', toolCallId: 'call-1', name: 'bash' },
    { type: 'tool_result', turnId: 'turn-1', toolCallId: 'call-1', result: 'ok', isError: false },
    { type: 'task', taskId: 'task-1', status: 'running', title: 'Build' },
    { type: 'updates_changed' },
    { type: 'context_usage' },
    {
      type: 'conversation_updated',
      conversation: { id: 'chat-a', title: 'New chat', updatedAt: null },
    },
  ];
  for (const event of events) {
    assert.equal(isConversationEvent(event), true, JSON.stringify(event));
  }
});
