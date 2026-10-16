import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { patchBundle } from './task-control.mjs';

const original = readFileSync(process.env.LETTA_BUNDLE || new URL('../../../backend/node_modules/@letta-ai/letta-code/letta.js', import.meta.url), 'utf8');
const patched = patchBundle(original);
const start = patched.indexOf('async function handleExecuteCommand(');
const end = patched.indexOf('\n}', start) + 2;

function fixture() {
  const scope = { agentId: 'agent', conversationId: 'chat' };
  const backgroundTasks = new Map([
    ['ours', { description: 'Research', runtimeScope: scope, status: 'running' }],
    ['other', { description: 'Private work', runtimeScope: { ...scope, conversationId: 'other' }, status: 'running' }],
  ]);
  const backgroundProcesses = new Map([
    ['command', { command: 'echo hello', stdout: ['hello'], runtimeScope: scope, status: 'running' }],
    ['unscoped', { command: 'unrelated', status: 'running' }],
  ]);
  const stopped = [];
  let response;
  const handle = runInNewContext(patched.slice(start, end) + '\nhandleExecuteCommand', {
    backgroundTasks, backgroundProcesses,
    init_task_stop() {},
    task_stop: async ({ task_id }) => { stopped.push(task_id); return { killed: true }; },
    emitExecuteCommandResponse: (_socket, _command, value) => { response = value; },
  });
  return { stopped, async send(command_id, args) {
    await handle({ command_id, args, runtime: { agent_id: 'agent', conversation_id: 'chat' } }, {}, {}, {});
    return JSON.parse(JSON.stringify(response));
  } };
}

test('native task inventory includes agents and commands only in the requested conversation', async () => {
  const fixtureState = fixture();
  const response = await fixtureState.send('assistant_tasks');
  assert.equal(response.success, true);
  const tasks = JSON.parse(response.output);
  assert.deepEqual(tasks.map((t) => [t.id, t.kind]), [['ours', 'agent'], ['command', 'command']]);
  assert.equal(tasks[1].report, 'hello');
});

test('native stop uses TaskStop and rejects unrelated or unknown work', async () => {
  const fixtureState = fixture();
  for (const id of ['other', 'unscoped', 'missing']) {
    assert.equal((await fixtureState.send('assistant_task_stop', id)).success, false);
  }
  assert.deepEqual(fixtureState.stopped, []);
  assert.equal((await fixtureState.send('assistant_task_stop', 'ours')).success, true);
  assert.equal((await fixtureState.send('assistant_task_stop', 'command')).success, true);
  assert.deepEqual(fixtureState.stopped, ['ours', 'command']);
});

test('task patch fails closed on an unsupported or already patched bundle', () => {
  assert.throws(() => patchBundle('different release'), /unpatched/);
  assert.throws(() => patchBundle(patched), /unpatched/);
});
