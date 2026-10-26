import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SubagentSpec } from '../types.ts';
import { EphemeralStorage } from '@artemis/storage/testing';
import { createHarness, seedConversation, until } from '../../../test/workers-support.ts';
import { resumedHistory } from './subagent-task-worker.ts';

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

test('a resume chain over the cap replays its newest tasks behind a notice counting the omitted ones', async () => {
  const storage = new EphemeralStorage();
  await storage.conversations.create(
    { id: 'c1', title: null, titleSource: null },
    { systemPrompt: 'S', tools: [], templateId: 'system', templateHash: 'test' }
  );
  let previous: string | null = null;
  for (let index = 0; index < 21; index += 1) {
    const id = `task_chain_${index}`;
    await storage.tasks.create({
      id,
      conversationId: 'c1',
      kind: 'agent',
      status: 'completed',
      title: 'Step',
      prompt: 'step',
      subagentType: 'general-purpose',
      command: null,
      cwd: null,
      outputPath: null,
      needsInput: false,
      originMode: 'text',
      originTurnId: null,
      originToolCallId: null,
      parentTaskId: null,
      resumedFromTaskId: previous,
      depth: 0,
      model: null,
      startedAt: '2026-10-26T10:00:00.000Z',
    });
    previous = id;
  }

  const overCap = await resumedHistory(storage, 'c1', previous);
  assert.equal(overCap[0]?.role, 'user');
  assert.match(JSON.stringify(overCap[0]), /1 earlier resumed tasks are omitted/);

  const atCap = await resumedHistory(storage, 'c1', 'task_chain_19');
  assert.equal(JSON.stringify(atCap).includes('omitted'), false);
});
