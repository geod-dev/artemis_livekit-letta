import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixedId } from '@artemis/core';
import { storageContract } from '../../../test/storage-contract.ts';
import { EphemeralStorage } from './ephemeral-storage.ts';

storageContract('EphemeralStorage', async () => ({
  fresh: async () => new EphemeralStorage(),
  dispose: async () => {},
}));

test('EphemeralStorage migrate applies nothing and reports healthy', async () => {
  const storage = new EphemeralStorage();
  assert.deepEqual(await storage.migrate(), []);
  assert.equal(await storage.healthy(), true);
  await storage.close();
});

test('EphemeralStorage returns detached copies that callers cannot use to mutate state', async () => {
  const storage = new EphemeralStorage();
  const id = '00000000-0000-4000-8000-000000000001';
  const created = await storage.conversations.create(
    { id, title: 'a', titleSource: 'user' },
    {
      systemPrompt: 'p',
      tools: [{ name: 'x' }],
      templateId: 't',
      templateHash: 'h',
    }
  );
  created.title = 'mutated';
  (await storage.promptSnapshots.getForOwner('conversation', id))?.tools.push('oops');

  assert.equal((await storage.conversations.get(id))?.title, 'a');
  assert.deepEqual((await storage.promptSnapshots.getForOwner('conversation', id))?.tools, [{ name: 'x' }]);
});

test('EphemeralStorage conversations use the injected clock for timestamps', async () => {
  let now = Date.parse('2026-02-03T04:05:06.000Z');
  const storage = new EphemeralStorage({
    clock: { now: () => now, setTimeout: () => ({ cancel() {} }), setInterval: () => ({ cancel() {} }) },
  });
  const row = await storage.conversations.create(
    { id: '00000000-0000-4000-8000-000000000002', title: null, titleSource: null },
    {
      systemPrompt: 'p',
      tools: [],
      templateId: 't',
      templateHash: 'h',
    }
  );
  assert.equal(row.createdAt, '2026-02-03T04:05:06.000Z');
  now += 1000;
  await storage.conversations.touch(row.id, new Date(now).toISOString());
  assert.equal((await storage.conversations.get(row.id))?.lastMessageAt, '2026-02-03T04:05:07.000Z');
});

test('EphemeralStorage transactions wait for queued operations and roll back on failure', async () => {
  const storage = new EphemeralStorage();
  const id = '00000000-0000-4000-8000-000000000003';
  const outside = storage.conversations.get(id);
  const failing = storage.transaction(async (tx) => {
    await tx.conversations.create(
      { id, title: null, titleSource: null },
      { systemPrompt: 'p', tools: [], templateId: 't', templateHash: 'h' }
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error('abort');
  });
  await assert.rejects(failing, /abort/);
  assert.equal(await outside, null);
  assert.equal(await storage.conversations.get(id), null);
});

test('EphemeralStorage progress after finish keeps the final tails', async () => {
  const storage = new EphemeralStorage();
  const conversationId = '00000000-0000-4000-8000-000000000004';
  await storage.conversations.create(
    { id: conversationId, title: null, titleSource: null },
    { systemPrompt: 'p', tools: [], templateId: 't', templateHash: 'h' }
  );
  const task = await storage.tasks.create({
    id: prefixedId('task'),
    conversationId,
    kind: 'command',
    status: 'running',
    title: 'Build',
    prompt: null,
    subagentType: null,
    command: 'npm run build',
    cwd: '/workspace',
    outputPath: null,
    needsInput: false,
    originMode: 'text',
    originTurnId: null,
    originToolCallId: null,
    parentTaskId: null,
    resumedFromTaskId: null,
    depth: 0,
    model: null,
    startedAt: '2026-01-01T00:01:00.000Z',
  });

  await storage.tasks.updateProgress(task.id, { stdoutTail: 'building', outputPath: '/workspace/data/task.log' });
  assert.equal((await storage.tasks.get(task.id))?.stdoutTail, 'building');

  await storage.tasks.finish(task.id, {
    status: 'completed',
    report: 'done',
    needsInput: false,
    exitCode: 0,
    stdoutTail: 'built',
    stderrTail: 'warn',
    usage: null,
    endedAt: '2026-01-01T00:02:00.000Z',
  });
  await storage.tasks.updateProgress(task.id, { stdoutTail: 'late', stderrTail: 'late', outputPath: '/late.log' });

  const row = await storage.tasks.get(task.id);
  assert.equal(row?.status, 'completed');
  assert.equal(row?.stdoutTail, 'built');
  assert.equal(row?.stderrTail, 'warn');
  assert.equal(row?.outputPath, '/workspace/data/task.log');
  await assert.rejects(storage.tasks.updateProgress(prefixedId('task'), { stdoutTail: 'x' }), /task/);
});
