import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageContract } from '../contract/storage-contract.ts';
import { InMemoryStorage } from './in-memory-storage.ts';

storageContract('InMemoryStorage', async () => ({
  fresh: async () => new InMemoryStorage(),
  dispose: async () => {},
}));

test('InMemoryStorage migrate applies nothing and reports healthy', async () => {
  const storage = new InMemoryStorage();
  assert.deepEqual(await storage.migrate(), []);
  assert.equal(await storage.healthy(), true);
  await storage.close();
});

test('InMemoryStorage returns detached copies that callers cannot use to mutate state', async () => {
  const storage = new InMemoryStorage();
  const id = '00000000-0000-4000-8000-000000000001';
  const created = await storage.conversations.create({ id, title: 'a', titleSource: 'user' }, {
    systemPrompt: 'p',
    tools: [{ name: 'x' }],
    templateId: 't',
    templateHash: 'h',
  });
  created.title = 'mutated';
  (await storage.promptSnapshots.getForOwner('conversation', id))?.tools.push('oops');

  assert.equal((await storage.conversations.get(id))?.title, 'a');
  assert.deepEqual((await storage.promptSnapshots.getForOwner('conversation', id))?.tools, [{ name: 'x' }]);
});

test('InMemoryStorage conversations use the injected clock for timestamps', async () => {
  let now = Date.parse('2026-02-03T04:05:06.000Z');
  const storage = new InMemoryStorage({ clock: { now: () => now, setTimeout: () => ({ cancel() {} }), setInterval: () => ({ cancel() {} }) } });
  const row = await storage.conversations.create({ id: '00000000-0000-4000-8000-000000000002', title: null, titleSource: null }, {
    systemPrompt: 'p',
    tools: [],
    templateId: 't',
    templateHash: 'h',
  });
  assert.equal(row.createdAt, '2026-02-03T04:05:06.000Z');
  now += 1000;
  await storage.conversations.touch(row.id, new Date(now).toISOString());
  assert.equal((await storage.conversations.get(row.id))?.lastMessageAt, '2026-02-03T04:05:07.000Z');
});

test('InMemoryStorage transactions wait for queued operations and roll back on failure', async () => {
  const storage = new InMemoryStorage();
  const id = '00000000-0000-4000-8000-000000000003';
  const outside = storage.conversations.get(id);
  const failing = storage.transaction(async (tx) => {
    await tx.conversations.create({ id, title: null, titleSource: null }, { systemPrompt: 'p', tools: [], templateId: 't', templateHash: 'h' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error('abort');
  });
  await assert.rejects(failing, /abort/);
  assert.equal(await outside, null);
  assert.equal(await storage.conversations.get(id), null);
});
