import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger } from '@artemis/core';
import { InMemoryStorage } from '@artemis/storage';
import type { AgentServerConfig } from '../config.ts';
import { createMemoryCoordinator } from './coordinator.ts';
import { FakeClock, FakeMemoryStore, fact, seedConversation, seedTurn, settle } from './test-support.ts';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

function setup(options: { enabled?: boolean; maxAttempts?: number } = {}) {
  const clock = new FakeClock();
  const storage = new InMemoryStorage({ clock });
  const store = new FakeMemoryStore();
  const config = {
    assistant: { name: 'Artemis', timezone: 'UTC' },
    memory: {
      enabled: options.enabled ?? true,
      hindsightUrl: 'http://hindsight:8888',
      bankId: 'artemis',
      retainEvery: 3,
      recallTimeoutMs: { voice: 1500, text: 4000 },
      recallMaxTokens: { low: 800, mid: 1500, high: 3000 },
    },
  } as unknown as AgentServerConfig;
  const coordinator = createMemoryCoordinator({
    store,
    storage,
    config,
    clock,
    logger: silent,
    pumpIntervalMs: 1000,
    maxAttempts: options.maxAttempts,
  });
  return { clock, storage, store, coordinator };
}

test('retains the first three user turns (with interleaved updates) and marks them analyzed', async () => {
  const { storage, store, coordinator } = setup();
  await seedConversation(storage, 'c1');
  coordinator.start();
  const t1 = await seedTurn(storage, { id: 't1', conversationId: 'c1', text: 'hi', reply: 'hello' });
  const t2 = await seedTurn(storage, { id: 't2', conversationId: 'c1', text: 'two', reply: 'ok' });
  const u1 = await seedTurn(storage, { id: 'u1', conversationId: 'c1', kind: 'update', text: '', reply: 'Report ready' });
  const t3 = await seedTurn(storage, { id: 't3', conversationId: 'c1', text: 'three', reply: 'third' });
  const t4 = await seedTurn(storage, { id: 't4', conversationId: 'c1', text: 'four', reply: 'fourth' });

  for (const turn of [t1, t2, u1, t3]) await coordinator.turnCompleted(turn);
  await settle();

  assert.equal(store.retains.length, 1);
  const [request] = store.retains;
  assert.equal(request!.documentId, 'conversation:c1');
  assert.deepEqual(
    request!.turns.map((line) => `${line.speaker}:${line.text}`),
    ['User:hi', 'Artemis:hello', 'User:two', 'Artemis:ok', 'Artemis:Report ready', 'User:three', 'Artemis:third']
  );
  assert.equal(request!.timestamp, new Date(Date.parse(t3.startedAt) + 1000).toISOString());

  const unanalyzed = await storage.turns.listUnanalyzed('c1');
  assert.deepEqual(unanalyzed.map((turn) => turn.id), ['t4']);

  // A fourth user turn alone does not trigger another batch.
  await coordinator.turnCompleted(t4);
  await settle();
  assert.equal(store.retains.length, 1);
});

test('flushes the previous conversation when the last active one changes', async () => {
  const { storage, store, coordinator } = setup();
  await seedConversation(storage, 'c1');
  await seedConversation(storage, 'c2');
  await seedTurn(storage, { id: 't1', conversationId: 'c1', text: 'remember me', reply: 'ok' });
  coordinator.start();

  await coordinator.conversationActivated('c1');
  await settle();
  assert.equal(store.retains.length, 0, 'first activation has nothing to flush');

  await coordinator.conversationActivated('c2');
  await settle();
  assert.equal(store.retains.length, 1);
  assert.equal(store.retains[0]!.documentId, 'conversation:c1');
  assert.deepEqual(store.retains[0]!.turns.map((line) => line.text), ['remember me', 'ok']);
  assert.deepEqual(await storage.turns.listUnanalyzed('c1'), []);

  await coordinator.conversationActivated('c2');
  await settle();
  assert.equal(store.retains.length, 1, 'same conversation again flushes nothing');
});

test('keeps a failed retention in the outbox and retries it after backoff', async () => {
  const { clock, storage, store, coordinator } = setup();
  await seedConversation(storage, 'c1');
  store.retainFailures = 1;
  coordinator.start();
  for (const id of ['t1', 't2', 't3']) {
    const turn = await seedTurn(storage, { id, conversationId: 'c1', text: id, reply: 'r' });
    await coordinator.turnCompleted(turn);
  }
  await settle();
  assert.equal(store.retains.length, 0);
  const [pending] = await storage.memoryRetentions.listPending(10);
  assert.equal(pending!.attempts, 1);
  assert.equal(pending!.status, 'pending');

  clock.advance(1000);
  await settle();
  assert.equal(store.retains.length, 0, 'still inside the 2 s backoff');

  clock.advance(1000);
  await settle();
  assert.equal(store.retains.length, 1);
  assert.equal(store.retains[0]!.operationId, pending!.operationId, 'retries reuse the operation id');
  assert.deepEqual(await storage.memoryRetentions.listPending(10), []);
  await coordinator.stop();
});

test('marks a retention terminal after maxAttempts', async () => {
  const { clock, storage, store, coordinator } = setup({ maxAttempts: 2 });
  await seedConversation(storage, 'c1');
  store.retainFailures = 5;
  await seedTurn(storage, { id: 't1', conversationId: 'c1', text: 'x', reply: 'y' });
  coordinator.start();
  await coordinator.flush('c1', 'shutdown');
  await settle();
  clock.advance(2000);
  await settle();
  assert.deepEqual(await storage.memoryRetentions.listPending(10), [], 'terminal rows are not pending');
  assert.equal(store.retains.length, 0);
  await coordinator.stop();
});

test('recall gives up at the text timeout, records the trace and keeps the turn going', async () => {
  const { clock, storage, store, coordinator } = setup();
  await seedConversation(storage, 'c1');
  await seedTurn(storage, { id: 't9', conversationId: 'c1', text: 'q', effort: 'medium' });
  store.recallMode = 'hang';

  const pending = coordinator.recallFor({
    conversationId: 'c1',
    turnId: 't9',
    modality: 'text',
    effort: 'medium',
    query: 'q',
  });
  await settle();
  clock.advance(4000);
  const memories = await pending;

  assert.deepEqual(memories, []);
  const turn = await storage.turns.get('t9');
  assert.equal(turn!.recall!.budget, 'mid');
  assert.match(turn!.recall!.error ?? '', /timed out/);
});

test('recall drops memories already injected into the conversation', async () => {
  const { storage, store, coordinator } = setup();
  await seedConversation(storage, 'c1');
  await seedTurn(storage, { id: 't1', conversationId: 'c1', text: 'a' });
  await seedTurn(storage, { id: 't2', conversationId: 'c1', text: 'b' });
  const input = { conversationId: 'c1', modality: 'text' as const, effort: 'low' as const, query: 'q' };

  store.facts = [fact('f1', 'likes tea'), fact('f2', 'lives in Lyon')];
  const first = await coordinator.recallFor({ ...input, turnId: 't1' });
  assert.deepEqual(first.map((memory) => memory.id), ['f1', 'f2']);

  store.facts = [fact('f1', 'likes tea'), fact('f2', 'lives in Lyon'), fact('f3', 'owns a bike')];
  const second = await coordinator.recallFor({ ...input, turnId: 't2' });
  assert.deepEqual(second.map((memory) => memory.id), ['f3']);
});

test('recall budget and token cap follow the modality and effort', async () => {
  const cases: Array<{
    label: string;
    input: { modality: 'text' | 'voice'; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
    budget: string;
    maxTokens: number;
  }> = [
    { label: 'voice', input: { modality: 'voice', effort: 'max' }, budget: 'low', maxTokens: 800 },
    { label: 'text low', input: { modality: 'text', effort: 'low' }, budget: 'mid', maxTokens: 1500 },
    { label: 'text medium', input: { modality: 'text', effort: 'medium' }, budget: 'mid', maxTokens: 1500 },
    { label: 'text without effort', input: { modality: 'text' }, budget: 'mid', maxTokens: 1500 },
    { label: 'text high', input: { modality: 'text', effort: 'high' }, budget: 'high', maxTokens: 3000 },
    { label: 'text xhigh', input: { modality: 'text', effort: 'xhigh' }, budget: 'high', maxTokens: 3000 },
    { label: 'text max', input: { modality: 'text', effort: 'max' }, budget: 'high', maxTokens: 3000 },
  ];
  for (const scenario of cases) {
    const { storage, store, coordinator } = setup();
    await seedConversation(storage, 'c1');
    await coordinator.recallFor({ conversationId: 'c1', turnId: 'missing', query: 'q', ...scenario.input });
    const request = store.recalls.at(-1)!;
    assert.equal(request.budget, scenario.budget, scenario.label);
    assert.equal(request.maxTokens, scenario.maxTokens, scenario.label);
  }
});

test('disabled memory neither recalls nor retains', async () => {
  const { storage, store, coordinator } = setup({ enabled: false });
  await seedConversation(storage, 'c1');
  const turn = await seedTurn(storage, { id: 't1', conversationId: 'c1', text: 'hi', reply: 'hello' });
  coordinator.start();
  await coordinator.conversationActivated('c1');
  await coordinator.turnCompleted(turn);
  await coordinator.flush('c1', 'switch');
  assert.deepEqual(await coordinator.recallFor({ conversationId: 'c1', turnId: 't1', modality: 'text', query: 'q' }), []);
  assert.equal(store.recalls.length, 0);
  assert.equal(store.retains.length, 0);
  await coordinator.stop();
});

test('an outage that backs off the oldest pending rows does not starve the rows behind them', async () => {
  const { clock, storage, store, coordinator } = setup();
  await seedConversation(storage, 'c1');
  // 25 pending retentions, one turn each. The first 10 attempts (the oldest batch) fail.
  for (let i = 0; i < 25; i++) {
    const id = `t${String(i).padStart(2, '0')}`;
    await seedTurn(storage, { id, conversationId: 'c1', text: id, reply: 'r' });
    await storage.memoryRetentions.createForTurns({
      id: `r${String(i).padStart(2, '0')}`,
      conversationId: 'c1',
      turnIds: [id],
      documentId: `conversation:c1:${i}`,
      operationId: `op-${i}`,
      reason: 'batch',
    });
  }
  store.retainFailures = 10;
  coordinator.start();
  await settle();
  assert.equal(store.retains.length, 0, 'the first batch failed and is in backoff');

  // Still inside the 2 s backoff of the first batch: the rows behind it must go through.
  clock.advance(1000);
  await settle();
  assert.equal(store.retains.length, 10, 'the 10 rows behind the backed-off batch were submitted');
  assert.equal((await storage.memoryRetentions.listPending(100)).length, 15, 'the 10 backed-off rows and 5 unreached rows stay pending');
  await coordinator.stop();
});
