import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '@shared/chat-types';
import { mergeConversationMessages } from './conversation-messages.ts';
import {
  type LiveConversationItem,
  conversationStateReducer,
  initialConversationState,
} from './conversation-state.ts';

test('a streamed assistant reply is shown with its full text, above the pending user message', () => {
  const live: LiveConversationItem[] = [
    {
      turnId: 'turn-1',
      message: { id: 'assistant-1', role: 'assistant', text: 'Hello there' },
    },
  ];
  const pending: Extract<ChatMessage, { role: 'user' }> = {
    id: 'pending:client-1',
    role: 'user',
    text: 'hi',
    modality: 'text',
    clientMessageId: 'client-1',
  };
  assert.deepEqual(mergeConversationMessages([], live, pending), [
    { id: 'assistant-1', role: 'assistant', text: 'Hello there' },
    pending,
  ]);
});

test('a persisted reply with the same id as its streamed copy is shown once', () => {
  const row: ChatMessage = { id: 'assistant-1', role: 'assistant', text: 'Hello there' };
  assert.deepEqual(
    mergeConversationMessages([row], [{ turnId: 'turn-1', message: { ...row } }], null),
    [row]
  );
});

test('a persisted reply replaces its streamed copy when both carry the same block suffix', () => {
  // The real flow: loop-persistence.ts streams deltas as `${messageId}:${blockIndex}`, and
  // agent-server/src/conversations/history.ts projects each stored message's content blocks to
  // `${message.id}:${index}`, so the history row for a streamed text block has the suffixed id.
  const persisted: ChatMessage = { id: 'assistant-1:0', role: 'assistant', text: 'Hello there' };
  const merged = mergeConversationMessages(
    [persisted],
    [
      {
        turnId: 'turn-1',
        message: { id: 'assistant-1:0', role: 'assistant', text: 'Hello there' },
      },
    ],
    null
  );
  assert.equal(merged.length, 1, `expected one assistant reply, got ${merged.length}`);
  assert.equal(merged[0]?.role, 'assistant');
});

test('the same live message delivered twice is shown once', () => {
  const message: ChatMessage = { id: 'assistant-1', role: 'assistant', text: 'Hello there' };
  const merged = mergeConversationMessages(
    [],
    [
      { turnId: 'turn-1', message },
      { turnId: 'turn-1', message: { ...message } },
    ],
    null
  );
  assert.equal(merged.length, 1, `expected one message, got ${merged.length}`);
});

test('a state patch for another conversation is ignored', () => {
  const state = conversationStateReducer(initialConversationState, {
    type: 'activate',
    conversationId: 'chat-a',
    history: [],
  });
  const next = conversationStateReducer(state, {
    type: 'patch',
    conversationId: 'chat-b',
    patch: { error: 'boom', activeTurns: ['turn-b'] },
  });
  assert.equal(next, state);
});

test('a failed turn sets the error, and opening another conversation clears the error and in-flight turns', () => {
  let state = conversationStateReducer(initialConversationState, {
    type: 'activate',
    conversationId: 'chat-a',
    history: [],
  });
  state = conversationStateReducer(state, {
    type: 'patch',
    conversationId: 'chat-a',
    patch: { activeTurns: ['turn-1'] },
  });
  state = conversationStateReducer(state, {
    type: 'patch',
    conversationId: 'chat-a',
    patch: { error: 'Model request failed', activeTurns: [] },
  });
  assert.equal(state.error, 'Model request failed');
  assert.deepEqual(state.activeTurns, []);

  state = conversationStateReducer(state, {
    type: 'patch',
    conversationId: 'chat-a',
    patch: { error: 'Model request failed', activeTurns: ['turn-2'] },
  });
  state = conversationStateReducer(state, {
    type: 'activate',
    conversationId: 'chat-b',
    history: [],
  });
  assert.equal(state.error, null);
  assert.deepEqual(state.activeTurns, []);
  assert.deepEqual(state.live, []);
});

test('a snapshot replaces the in-flight turns instead of merging with them', () => {
  let state = conversationStateReducer(initialConversationState, {
    type: 'activate',
    conversationId: 'chat-a',
    history: [],
  });
  state = conversationStateReducer(state, {
    type: 'patch',
    conversationId: 'chat-a',
    patch: { activeTurns: ['turn-stale'] },
  });
  state = conversationStateReducer(state, {
    type: 'patch',
    conversationId: 'chat-a',
    patch: { activeTurns: ['turn-1'] },
  });
  assert.deepEqual(state.activeTurns, ['turn-1']);
});
