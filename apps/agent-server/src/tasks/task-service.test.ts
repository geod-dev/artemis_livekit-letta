import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, systemClock } from '@artemis/core';
import { EphemeralStorage } from '@artemis/storage/testing';
import { RecordingHub } from '../../test/workers-support.ts';
import type { SubagentSpec } from '../tools/task-port.ts';
import type { SubagentRun, TaskWorkers } from './task-service.ts';
import { createTaskService } from './task-service.ts';
import type { SubagentStartMode } from '../workers/types.ts';
import type { CommandHandoff } from '@artemis/tools/workspace-tools';

type CommandHandoffInput = Parameters<CommandHandoff['adopt']>[0];

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
  const calls = {
    registered: [] as string[],
    started: [] as Array<{ taskId: string; mode: SubagentStartMode }>,
    stopped: [] as string[],
    cancelled: [] as string[],
    forgotten: [] as string[],
  };
  const workers: TaskWorkers = {
    runningSubagentCount: () => options.running ?? 0,
    runningCommandCount: () => 0,
    registerSubagent: (taskId): SubagentRun => {
      calls.registered.push(taskId);
      return {
        taskId,
        outcome: new Promise(() => {}),
        stop: async () => {
          calls.cancelled.push(taskId);
        },
      };
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
      maxCommandTasks: 8,
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

const commandInput = (conversationId: string) =>
  ({
    process: {} as never,
    command: 'sleep 1000',
    description: 'Wait',
    cwd: '.',
    reason: 'requested',
    context: {
      conversationId,
      taskId: null,
      turnId: null,
      toolCallId: null,
      mode: 'text',
      taskDepth: 0,
      calls: {},
      tasks: {},
    } as unknown as CommandHandoffInput['context'],
  }) as const;

test('background command adoptions past maxCommandTasks are refused with 429 and create no task', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_cmd');
  const { workers } = recordingWorkers();
  // The first eight adoptions never finish starting; a ninth one would be let through unless refused.
  let adoptions = 0;
  workers.adoptCommand = () => (adoptions++ < 8 ? new Promise(() => {}) : Promise.resolve(undefined));
  const tasks = serviceOver(storage, workers);

  for (let index = 0; index < 8; index += 1) void tasks.adopt(commandInput('conv_cmd'));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(tasks.adopt(commandInput('conv_cmd')), (error: unknown) => error instanceof AppError && error.status === 429);
  assert.equal((await storage.tasks.listByConversation('conv_cmd')).length, 8);
});

test('resuming a task that is still running is refused with 409 and creates no task', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_resume');
  const { workers } = recordingWorkers();
  const tasks = serviceOver(storage, workers);
  const { taskId } = await tasks.startSubagent(spec('conv_resume'));

  await assert.rejects(
    tasks.startSubagent(spec('conv_resume', { resumedFromTaskId: taskId })),
    (error: unknown) => error instanceof AppError && error.status === 409
  );
  assert.equal((await storage.tasks.listByConversation('conv_resume')).length, 1);
});

test('a subagent aborted while its worker is still spawning is cancelled before start returns', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_abort');
  const { workers, calls } = recordingWorkers();
  // start() never returns, as when the prompt render is slow.
  workers.startSubagent = () => new Promise(() => {});
  const tasks = serviceOver(storage, workers);
  const controller = new AbortController();

  void tasks.runSubagent(spec('conv_abort'), controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.cancelled, calls.registered);
  assert.equal(calls.cancelled.length, 1);
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
