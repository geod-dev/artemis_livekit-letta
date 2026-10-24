import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, systemClock } from '@artemis/core';
import { EphemeralStorage } from '@artemis/storage/testing';
import { RecordingHub } from '../../test/workers-support.ts';
import type { SubagentSpec } from '../tools/task-port.ts';
import type { SubagentRun, TaskWorkers } from './task-service.ts';
import { createTaskService } from './task-service.ts';
import type { SubagentStartMode } from '../workers/types.ts';

const spec = (conversationId: string, overrides: Partial<SubagentSpec> = {}): SubagentSpec => ({
  conversationId,
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

async function createConversation(storage: EphemeralStorage, conversationId: string): Promise<void> {
  await storage.conversations.create(
    { id: conversationId, title: null, titleSource: null },
    { systemPrompt: 'S', tools: [], templateId: 'system', templateHash: 'test' }
  );
}

/** Workers that record what the task service asks of them; the subagent outcome never settles. */
function recordingWorkers(options: { running?: number } = {}) {
  const calls = { registered: [] as string[], started: [] as Array<{ taskId: string; mode: SubagentStartMode }>, stopped: [] as string[], forgotten: [] as string[] };
  const workers: TaskWorkers = {
    runningSubagentCount: () => options.running ?? 0,
    registerSubagent: (taskId): SubagentRun => {
      calls.registered.push(taskId);
      return { taskId, outcome: new Promise(() => {}), stop: async () => {} };
    },
    forgetSubagent: (taskId) => {
      calls.forgotten.push(taskId);
    },
    startSubagent: async (run, mode) => {
      calls.started.push({ taskId: run.taskId, mode });
      return run;
    },
    adoptCommand: async () => undefined,
    stopTask: async (taskId) => {
      calls.stopped.push(taskId);
      return true;
    },
  };
  return { workers, calls };
}

function serviceOver(storage: EphemeralStorage, workers: TaskWorkers, hub = new RecordingHub()) {
  return createTaskService(
    {
      storage,
      hub,
      clock: systemClock,
      subagents: [{ name: 'general-purpose', description: 'General work', instructions: 'Do the task.' }],
      maxSubagents: 2,
    },
    workers
  );
}

test('starting a background subagent creates a running task, registers and starts its worker, and announces it', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_start');
  const { workers, calls } = recordingWorkers();
  const hub = new RecordingHub();
  const tasks = serviceOver(storage, workers, hub);

  const { taskId } = await tasks.startSubagent(spec('conv_start'));

  assert.deepEqual(calls.registered, [taskId]);
  assert.deepEqual(calls.started, [{ taskId, mode: 'background' }]);
  const task = await storage.tasks.get(taskId);
  assert.equal(task?.status, 'running');
  assert.equal(task?.kind, 'agent');
  assert.equal(task?.title, 'Research');
  assert.ok(hub.events.some(({ event }) => event.type === 'task' && event.taskId === taskId && event.status === 'running'));
});

test('a start beyond maxSubagents is refused before any task or worker exists', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_full');
  const { workers, calls } = recordingWorkers({ running: 2 });
  const tasks = serviceOver(storage, workers);

  await assert.rejects(tasks.startSubagent(spec('conv_full')), (error: unknown) => error instanceof AppError && error.status === 429);
  assert.deepEqual(calls.registered, []);
  assert.deepEqual(await storage.tasks.listByConversation('conv_full'), []);
});

test('an unknown subagent type fails the start and forgets the registered worker', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_unknown');
  const { workers, calls } = recordingWorkers();
  const tasks = serviceOver(storage, workers);

  await assert.rejects(
    tasks.startSubagent(spec('conv_unknown', { subagentType: 'missing' })),
    (error: unknown) => error instanceof AppError && error.status === 400
  );
  assert.equal(calls.forgotten.length, 1);
  assert.deepEqual(calls.started, []);
});

test('stop requests a running task of the conversation and reaches its worker', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_stop');
  const { workers, calls } = recordingWorkers();
  const tasks = serviceOver(storage, workers);
  const { taskId } = await tasks.startSubagent(spec('conv_stop'));

  assert.equal(await tasks.stop('conv_stop', taskId), true);
  assert.ok((await storage.tasks.get(taskId))?.stopRequestedAt);
  assert.deepEqual(calls.stopped, [taskId]);
});

test('stop does nothing for a task of another conversation or one that is not running', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_a');
  await createConversation(storage, 'conv_b');
  const { workers, calls } = recordingWorkers();
  const tasks = serviceOver(storage, workers);
  const { taskId } = await tasks.startSubagent(spec('conv_a'));

  assert.equal(await tasks.stop('conv_b', taskId), false);
  assert.deepEqual(calls.stopped, []);
  await storage.tasks.finish(taskId, {
    status: 'completed',
    report: 'done',
    needsInput: false,
    exitCode: null,
    stdoutTail: null,
    stderrTail: null,
    usage: null,
    endedAt: new Date().toISOString(),
  });
  assert.equal(await tasks.stop('conv_a', taskId), false);
  assert.deepEqual(calls.stopped, []);
});

test('list and get project the tasks of one conversation only', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_list');
  await createConversation(storage, 'conv_other');
  const { workers } = recordingWorkers();
  const tasks = serviceOver(storage, workers);
  const { taskId } = await tasks.startSubagent(spec('conv_list', { title: 'Listed' }));
  await tasks.startSubagent(spec('conv_other', { title: 'Elsewhere' }));

  const listed = await tasks.list('conv_list');
  assert.deepEqual(
    listed.map((task) => [task.id, task.title, task.status]),
    [[taskId, 'Listed', 'running']]
  );
  assert.equal((await tasks.get('conv_list', taskId))?.title, 'Listed');
  assert.equal(await tasks.get('conv_other', taskId), null);
});
