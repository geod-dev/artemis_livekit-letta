import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmRequest } from '@artemis/llm';
import { EphemeralStorage } from '@artemis/storage/testing';
import type { SubagentSpec } from './types.ts';
import type { TurnSubmission } from '../turns/types.ts';
import { createHarness, seedConversation, settled, until, type Harness, type Step } from '../../test/workers-support.ts';

const textTurn = (text: string): TurnSubmission => ({ kind: 'user', modality: 'text', mode: 'text', effort: 'medium', text });

/** Last user message of a request, as plain text (tool results and updates included). */
function lastUserText(request: LlmRequest): string {
  const last = request.messages.at(-1);
  if (!last || last.role !== 'user') return '';
  return last.content.map((block) => (block.type === 'text' ? block.text : block.type === 'tool_result' ? block.content.map((c) => (c.type === 'text' ? c.text : '')).join('') : '')).join('\n');
}

function bashTurn(command: string): Step {
  return { content: [{ type: 'tool_use', id: 'call_bash_1', name: 'bash', input: { command, description: 'wait' } }] };
}

test('a text turn persists the user message, the answer and completes the turn', async () => {
  const h = await createHarness(() => ({ content: [{ type: 'text', text: 'Hi!' }] }));
  await seedConversation(h, 'c1');
  const worker = await h.runtime.supervisor.mainAgent('c1');
  const outcome = await worker.submit(textTurn('hello')).done;

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.text, 'Hi!');
  const transcript = await h.storage.messages.transcript('c1', null);
  assert.deepEqual(transcript.map((message) => message.role), ['user', 'assistant']);
  assert.equal(transcript[0]?.envelope?.text, 'hello');
  const types = h.hub.events.map(({ event }) => event.type);
  assert.ok(types.includes('turn_start') && types.includes('assistant_delta') && types.includes('turn_end'));
  await h.runtime.supervisor.shutdown();
});

test('cancel aborts the running turn and stores the partial answer as aborted', async () => {
  const h = await createHarness(() => ({ content: [{ type: 'text', text: 'Partial' }], hangUntilAbort: true }));
  await seedConversation(h, 'c1');
  const worker = await h.runtime.supervisor.mainAgent('c1');
  const handle = worker.submit(textTurn('long question'));
  await until(() => h.hub.events.some(({ event }) => event.type === 'assistant_delta'));
  assert.equal(worker.cancel(), true);

  const outcome = await handle.done;
  assert.equal(outcome.status, 'cancelled');
  const assistant = (await h.storage.messages.transcript('c1', null)).find((message) => message.role === 'assistant');
  assert.equal(assistant?.stopReason, 'aborted');
  await h.runtime.supervisor.shutdown();
});

test('a handoff becomes a task, the update wakes the conversation and a disposed worker is respawned by the next message', async () => {
  const h = await createHarness((request) => {
    const last = lastUserText(request);
    if (last.includes('<background-update')) return { content: [{ type: 'text', text: 'Background done' }] };
    if (last.includes('run it')) return bashTurn('sleep 1 && echo finished-out');
    return { content: [{ type: 'text', text: 'Started' }] };
  });
  await seedConversation(h, 'c1');
  const worker = await h.runtime.supervisor.mainAgent('c1');
  const first = await worker.submit(textTurn('run it')).done;
  assert.equal(first.status, 'completed');

  const backgrounded = h.hub.events.find(({ event }) => event.type === 'tool_result');
  assert.ok(backgrounded && backgrounded.event.type === 'tool_result' && backgrounded.event.task?.relation === 'backgrounded');

  // A running task keeps the main worker alive, however long it has been idle.
  h.clock.advance(10 * 60_000);
  assert.ok(h.runtime.supervisor.peekMainAgent('c1'));

  await until(async () => (await h.storage.tasks.listByConversation('c1'))[0]?.status === 'completed');
  await until(async () => (await h.storage.updates.listByConversation('c1'))[0]?.delivery === 'delivered');
  const update = (await h.storage.updates.listByConversation('c1'))[0];
  assert.equal(update?.status, 'completed');
  assert.match(update?.report ?? '', /finished-out/);
  assert.ok(h.provider.requests.some((request) => lastUserText(request).includes('<background-update')));

  // Disposed while idle (the reaper's own clock is covered by registry.test.ts); the next message respawns it.
  await h.runtime.supervisor.stopConversation('c1', 'idle');
  assert.equal(h.runtime.supervisor.peekMainAgent('c1'), undefined);
  assert.equal(h.runtime.supervisor.peekMainAgent('c1'), undefined);
  const respawned = await h.runtime.supervisor.mainAgent('c1');
  assert.notEqual(respawned, worker);
  assert.equal((await respawned.submit(textTurn('again')).done).status, 'completed');
  await h.runtime.supervisor.shutdown();
});

test('a task cancelled by archive creates no update and does not respawn the main worker', async () => {
  const h = await createHarness((request) =>
    lastUserText(request).includes('run it') ? bashTurn('sleep 30 && echo late') : { content: [{ type: 'text', text: 'Started' }] }
  );
  await seedConversation(h, 'c1');
  const worker = await h.runtime.supervisor.mainAgent('c1');
  assert.equal((await worker.submit(textTurn('run it')).done).status, 'completed');
  await until(async () => (await h.storage.tasks.listByConversation('c1'))[0]?.status === 'running');
  const requestsBefore = h.provider.requests.length;

  // Archive as the conversations service does: the record first, then the supervisor's stop hook.
  assert.equal(await h.storage.conversations.archive('c1'), true);
  await h.runtime.supervisor.stopConversation('c1');
  await until(async () => (await h.storage.tasks.listByConversation('c1'))[0]?.status === 'cancelled');
  await until(() => h.hub.events.some(({ event }) => event.type === 'task' && event.status === 'finished'));
  await settled(h.runtime.supervisor);

  assert.deepEqual(await h.storage.updates.listByConversation('c1'), []);
  assert.equal(h.runtime.supervisor.peekMainAgent('c1'), undefined);
  assert.equal(h.provider.requests.length, requestsBefore);
  await h.runtime.supervisor.shutdown();
});

test('archive during a pending subagent start stops the worker: its loop and tools never run', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = await createHarness(() => ({ content: [{ type: 'text', text: 'must not run' }] }), { subagentGate: gate });
  await seedConversation(h, 'c1');
  const spec: SubagentSpec = {
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
  };
  const started = h.runtime.tasks.startSubagent(spec);
  // The task row exists; the worker is still spawning (its prompt render is held by the gate).
  await until(async () => (await h.storage.tasks.listByConversation('c1'))[0]?.status === 'running');
  assert.equal(h.runtime.supervisor.runningSubagentCount(), 1);

  // Archive as the conversations service does: the record first, then the supervisor's stop hook.
  assert.equal(await h.storage.conversations.archive('c1'), true);
  await h.runtime.supervisor.stopConversation('c1');
  release();
  const { taskId } = await started;

  await until(async () => (await h.storage.tasks.get(taskId))?.status === 'cancelled');
  await until(() => h.runtime.supervisor.runningSubagentCount() === 0);
  assert.equal(h.provider.requests.length, 0, 'the loop never called the model, so no tool ran');
  assert.equal((await h.storage.tasks.get(taskId))?.status, 'cancelled');
  assert.deepEqual(await h.storage.updates.listByConversation('c1'), []);
  await h.runtime.supervisor.shutdown();
});

test('a successful voice-short task stays held and does not wake the conversation', async () => {
  const h = await createHarness(() => ({ content: [{ type: 'text', text: 'unused' }] }));
  await seedConversation(h, 'c1');
  const task = await h.storage.tasks.create({
    id: 'task_voice',
    conversationId: 'c1',
    kind: 'agent',
    status: 'running',
    title: 'Research',
    prompt: 'p',
    subagentType: 'general-purpose',
    command: null,
    cwd: null,
    outputPath: null,
    needsInput: false,
    originMode: 'voice-short',
    originTurnId: null,
    originToolCallId: null,
    parentTaskId: null,
    resumedFromTaskId: null,
    depth: 0,
    model: null,
    startedAt: new Date().toISOString(),
  });
  const finished = await h.storage.tasks.finish(task.id, {
    status: 'completed',
    report: 'Done',
    needsInput: false,
    exitCode: null,
    stdoutTail: null,
    stderrTail: null,
    usage: null,
    endedAt: new Date().toISOString(),
  });
  const update = await h.runtime.delivery.taskFinished(finished!);
  await settled(h.runtime.supervisor);
  assert.ok(update);
  assert.equal(update.delivery, 'held');
  assert.equal(h.provider.requests.length, 0);
  await h.runtime.supervisor.shutdown();
});

test('tasks at depth > 0 never wake the conversation, failures of depth 0 always do', async () => {
  const h = await createHarness(() => ({ content: [{ type: 'text', text: 'Failure noted' }] }));
  await seedConversation(h, 'c1');
  const make = async (id: string, status: 'completed' | 'failed', depth: number) => {
    await h.storage.tasks.create({
      id,
      conversationId: 'c1',
      kind: 'agent',
      status: 'running',
      title: id,
      prompt: 'p',
      subagentType: 'general-purpose',
      command: null,
      cwd: null,
      outputPath: null,
      needsInput: false,
      originMode: 'text',
      originTurnId: null,
      originToolCallId: null,
      parentTaskId: null,
      resumedFromTaskId: null,
      depth,
      model: null,
      startedAt: new Date().toISOString(),
    });
    const record = await h.storage.tasks.finish(id, {
      status,
      report: 'r',
      needsInput: false,
      exitCode: null,
      stdoutTail: null,
      stderrTail: null,
      usage: null,
      endedAt: new Date().toISOString(),
    });
    return h.runtime.delivery.taskFinished(record!);
  };
  await make('task_nested', 'failed', 1);
  await settled(h.runtime.supervisor);
  assert.equal(h.provider.requests.length, 0);

  await make('task_root', 'failed', 0);
  await until(() => h.provider.requests.length === 1);
  await until(async () => (await h.storage.updates.listByConversation('c1')).every((u) => u.delivery === 'delivered'));
  await h.runtime.supervisor.shutdown();
});

test('recovery fails interrupted turns and tasks and delivers the task failure to the conversation', async () => {
  const storage = new EphemeralStorage();
  const seeded = await createHarness(() => ({ content: [{ type: 'text', text: 'unused' }] }), { storage });
  await seedConversation(seeded, 'c1');
  const turn = await storage.turns.create({
    id: 'turn_interrupted',
    conversationId: 'c1',
    kind: 'user',
    modality: 'text',
    mode: 'text',
    effort: 'medium',
    status: 'running',
    clientMessageId: null,
    model: null,
    startedAt: new Date().toISOString(),
  });
  await storage.tasks.create({
    id: 'task_interrupted',
    conversationId: 'c1',
    kind: 'agent',
    status: 'running',
    title: 'Long job',
    prompt: 'p',
    subagentType: 'general-purpose',
    command: null,
    cwd: null,
    outputPath: null,
    needsInput: false,
    originMode: 'text',
    originTurnId: turn.id,
    originToolCallId: null,
    parentTaskId: null,
    resumedFromTaskId: null,
    depth: 0,
    model: null,
    startedAt: new Date().toISOString(),
  });

  // A fresh process over the same storage: nothing in memory, everything from the database.
  const h = await createHarness(() => ({ content: [{ type: 'text', text: 'Recovered' }] }), { storage });
  await h.runtime.supervisor.recover();

  assert.equal((await storage.turns.get(turn.id))?.status, 'failed');
  assert.equal((await storage.tasks.get('task_interrupted'))?.status, 'failed');
  await until(() => h.provider.requests.length === 1);
  await until(() => h.hub.events.some(({ event }) => event.type === 'turn_end' && event.success));
  assert.ok(h.provider.requests.some((request) => lastUserText(request).includes('Interrupted by a server restart')));
  await h.runtime.supervisor.shutdown();
});

/** A held background update of conversation `c1`, as a finished task leaves it before any turn claims it. */
async function holdUpdate(h: Harness, updateId: string): Promise<void> {
  const now = new Date().toISOString();
  await h.storage.tasks.create({
    id: `task_${updateId}`,
    conversationId: 'c1',
    kind: 'agent',
    status: 'completed',
    title: 'Held',
    prompt: 'p',
    subagentType: 'general-purpose',
    command: null,
    cwd: null,
    outputPath: null,
    needsInput: false,
    originMode: 'text',
    originTurnId: null,
    originToolCallId: null,
    parentTaskId: null,
    resumedFromTaskId: null,
    depth: 0,
    model: null,
    startedAt: now,
  });
  await h.storage.updates.create({
    id: updateId,
    conversationId: 'c1',
    taskId: `task_${updateId}`,
    title: 'Held',
    status: 'completed',
    needsInput: false,
    report: 'done',
    durationMs: 1,
    depth: 0,
    delivery: 'held',
    unread: true,
    createdAt: now,
  });
}

test('an update turn whose update a queued user turn already claimed runs no model call and writes no rows', async () => {
  const h = await createHarness(() => ({ content: [{ type: 'text', text: 'Answer' }] }));
  await seedConversation(h, 'c1');
  await holdUpdate(h, 'upd_claimed_first');
  const worker = await h.runtime.supervisor.mainAgent('c1');

  // The user turn queues first and claims the held update; the wake (update turn) runs after it with nothing left.
  const user = worker.submit(textTurn('hello'));
  const wake = worker.submit({ kind: 'update', modality: 'text', mode: 'text', effort: 'low', text: '' });

  assert.equal((await user.done).status, 'completed');
  assert.equal((await wake.done).status, 'completed');
  assert.equal(h.provider.requests.length, 1, 'only the user turn called the model');
  const transcript = await h.storage.messages.transcript('c1', null);
  assert.deepEqual(transcript.map((message) => message.role), ['user', 'assistant'], 'the empty update wrote no user or assistant row');
  assert.equal((await h.storage.updates.get('upd_claimed_first'))?.delivery, 'delivered');
  await h.runtime.supervisor.shutdown();
});

test('a failure after a completed turn still reports the turn completed', async () => {
  const h = await createHarness(() => ({ content: [{ type: 'text', text: 'Hi!' }] }));
  await seedConversation(h, 'c1');
  // The follow-ups read the conversation after the turn row is completed: fail that read only.
  let turnEnded = false;
  const publish = h.hub.publish.bind(h.hub);
  h.hub.publish = (conversationId, event) => {
    publish(conversationId, event);
    if (event.type === 'turn_end') turnEnded = true;
  };
  const conversations = h.storage.conversations;
  const get = conversations.get.bind(conversations);
  conversations.get = async (id) => {
    if (turnEnded) throw new Error('database unavailable');
    return get(id);
  };

  const worker = await h.runtime.supervisor.mainAgent('c1');
  const outcome = await worker.submit(textTurn('hello')).done;

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.error, undefined);
  assert.equal((await h.storage.turns.get(outcome.turnId))?.status, 'completed');
  await h.runtime.supervisor.shutdown();
});
