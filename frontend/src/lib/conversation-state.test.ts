import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationStateReducer, initialConversationState } from './conversation-state.ts';

test('history requests commit only for the active conversation and newest revision', () => {
  let state = conversationStateReducer(initialConversationState, {
    type: 'activate',
    conversationId: 'chat-a',
    history: [],
  });
  state = conversationStateReducer(state, {
    type: 'history-requested',
    conversationId: 'chat-a',
    revision: 2,
  });
  const stale = conversationStateReducer(state, {
    type: 'history-loaded',
    conversationId: 'chat-a',
    revision: 1,
    history: [],
  });
  assert.equal(stale, state);

  const wrongConversation = conversationStateReducer(state, {
    type: 'history-loaded',
    conversationId: 'chat-b',
    revision: 2,
    history: [],
  });
  assert.equal(wrongConversation, state);
});

test('a valid history result updates request state and a new conversation resets turns', () => {
  let state = conversationStateReducer(initialConversationState, {
    type: 'activate',
    conversationId: 'chat-a',
    history: [],
  });
  state = conversationStateReducer(state, {
    type: 'patch',
    conversationId: 'chat-a',
    patch: { activeTurns: ['turn-a'] },
  });
  state = conversationStateReducer(state, {
    type: 'history-requested',
    conversationId: 'chat-a',
    revision: 1,
  });
  state = conversationStateReducer(state, {
    type: 'history-loaded',
    conversationId: 'chat-a',
    revision: 1,
    history: [{ id: 'message-a', role: 'assistant', text: 'hello' }],
  });
  assert.equal(state.historyRequest.status, 'ready');
  assert.equal(state.history[0]?.id, 'message-a');

  state = conversationStateReducer(state, {
    type: 'activate',
    conversationId: 'chat-b',
    history: [],
  });
  assert.deepEqual(state.activeTurns, []);
  assert.equal(state.conversationId, 'chat-b');
});
