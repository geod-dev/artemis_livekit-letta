import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmRequest } from '@artemis/llm';
import { InMemoryStorage } from '@artemis/storage';
import type { TurnSubmission } from './types.ts';
import { createHarness, seedConversation, until, type Harness, type Step } from './test-support.ts';

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

test('a handoff becomes a task, the update wakes the conversation and the worker is reaped only when idle', async () => {
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
  assert.deepEqual(await h.runtime.supervisor.reap(), []);
  assert.ok(h.runtime.supervisor.peekMainAgent('c1'));

  await until(async () => (await h.storage.tasks.listByConversation('c1'))[0]?.status === 'completed');
  await until(async () => (await h.storage.updates.listByConversation('c1'))[0]?.delivery === 'delivered');
  const update = (await h.storage.updates.listByConversation('c1'))[0];
  assert.equal(update?.status, 'completed');
  assert.match(update?.report ?? '', /finished-out/);
  assert.ok(h.provider.requests.some((request) => lastUserText(request).includes('<background-update')));

  // Idle past the timeout: the reaper disposes the worker; the next message respawns it.
  h.clock.advance(121_000);
  await until(async () => (await h.runtime.supervisor.reap()).includes('c1'));
  assert.equal(h.runtime.supervisor.peekMainAgent('c1'), undefined);
  const respawned = await h.runtime.supervisor.mainAgent('c1');
  assert.notEqual(respawned, worker);
  assert.equal((await respawned.submit(textTurn('again')).done).status, 'completed');
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
  await new Promise((resolve) => setTimeout(resolve, 50));
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
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.provider.requests.length, 0);

  await make('task_root', 'failed', 0);
  await until(() => h.provider.requests.length === 1);
  await until(async () => (await h.storage.updates.listByConversation('c1')).every((u) => u.delivery === 'delivered'));
  await h.runtime.supervisor.shutdown();
});

test('recovery fails interrupted turns and tasks and delivers the task failure to the conversation', async () => {
  const storage = new InMemoryStorage();
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
