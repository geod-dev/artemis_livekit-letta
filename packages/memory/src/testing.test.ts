import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RecallRequest } from './store.ts';
import { FakeMemoryStore } from './testing.ts';

const request: RecallRequest = {
  query: 'what do I prefer?',
  budget: 'low',
  maxTokens: 256,
  queryTimestamp: '2026-10-26T09:00:00Z',
};

test('the hang fake settles on an already-aborted signal', async () => {
  const store = new FakeMemoryStore();
  store.recallMode = 'hang';
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.recall(request, controller.signal), /aborted by caller/);
});

test('the hang fake settles when the caller aborts while waiting', async () => {
  const store = new FakeMemoryStore();
  store.recallMode = 'hang';
  const controller = new AbortController();
  const pending = store.recall(request, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted by caller/);
});
