import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemClock } from '@artemis/core';
import { EphemeralStorage } from '@artemis/storage/testing';
import type { WorkspaceProcess, WorkspaceTransport } from '@artemis/workspace';
import { silentLogger } from '../../test/workers-support.ts';
import { CommandTaskWorker, type CommandTaskInput } from './command-task-worker.ts';

/** Test double of a command that already exited: the worker only calls these members. */
function exitedProcess(): WorkspaceProcess {
  return {
    exited: Promise.resolve({ exitCode: 0, signal: null, timedOut: false }),
    async *output() {},
    tail: () => ({ stdout: '', stderr: '' }),
    kill: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  } as unknown as WorkspaceProcess;
}

const workspace = { writeFile: async () => {} } as unknown as WorkspaceTransport;

function commandInput(taskId: string): CommandTaskInput {
  return {
    taskId,
    conversationId: 'conv_failure',
    process: exitedProcess(),
    outputPath: `data/tasks/${taskId}.log`,
    command: 'true',
  };
}

test('a command whose task row is gone still settles, as a failed outcome', async () => {
  const worker = new CommandTaskWorker(commandInput('task_gone'), {
    storage: new EphemeralStorage(),
    workspace,
    clock: systemClock,
    logger: silentLogger,
  });
  await worker.start();
  const { task } = await worker.outcome;
  assert.equal(task.status, 'failed');
  assert.match(task.report ?? '', /disappeared/);
  assert.equal(worker.state, 'stopped');
});

test('a store failure while ending a command settles the worker as failed', async () => {
  const storage = new EphemeralStorage();
  storage.tasks.finish = async () => {
    throw new Error('store is down');
  };
  const worker = new CommandTaskWorker(commandInput('task_store'), {
    storage,
    workspace,
    clock: systemClock,
    logger: silentLogger,
  });
  await worker.start();
  const { task } = await worker.outcome;
  assert.equal(task.status, 'failed');
  assert.match(task.report ?? '', /store is down/);
  assert.equal(worker.state, 'stopped');
});
