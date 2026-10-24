import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SubagentSpec } from '../types.ts';
import { createHarness, seedConversation, until } from '../../../test/workers-support.ts';

const spec = (overrides: Partial<SubagentSpec> = {}): SubagentSpec => ({
  conversationId: 'c1',
  subagentType: 'general-purpose',
  title: 'Research',
  prompt: 'look around',
  originMode: 'text',
  originTurnId: null,
  originToolCallId: null,
  parentTaskId: null,
  resumedFromTaskId: null,
  depth: 0,
  ...overrides,
});

test('a synchronous subagent run returns its final text as the report and completes the task', async () => {
  const h = await createHarness(() => ({ content: [{ type: 'text', text: 'Found three files.' }] }));
  await seedConversation(h, 'c1');

  const result = await h.runtime.tasks.runSubagent(spec(), new AbortController().signal);

  assert.equal(result.status, 'completed');
  assert.equal(result.report, 'Found three files.');
  const task = await h.storage.tasks.get(result.taskId);
  assert.equal(task?.status, 'completed');
  assert.equal(task?.report, 'Found three files.');
  assert.deepEqual(
    (await h.storage.messages.transcript('c1', result.taskId)).map((message) => message.role),
    ['user', 'assistant']
  );
  await h.runtime.supervisor.shutdown();
});

test('a background subagent run completes its task and leaves an update for the main agent', async () => {
  const h = await createHarness(() => ({ content: [{ type: 'text', text: 'Background report.' }] }));
  await seedConversation(h, 'c1');

  const { taskId } = await h.runtime.tasks.startSubagent(spec({ title: 'Background research' }));

  await until(async () => (await h.storage.tasks.get(taskId))?.status === 'completed');
  const task = await h.storage.tasks.get(taskId);
  assert.equal(task?.report, 'Background report.');
  assert.equal(task?.needsInput, false);
  await until(async () => (await h.storage.updates.listByConversation('c1')).some((update) => update.taskId === taskId));
  const update = (await h.storage.updates.listByConversation('c1')).find((candidate) => candidate.taskId === taskId);
  assert.equal(update?.status, 'completed');
  assert.equal(update?.report, 'Background report.');
  await h.runtime.supervisor.shutdown();
});
