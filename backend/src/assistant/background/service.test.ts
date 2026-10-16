import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeDelivery,
  configureBackgroundPorts,
  listTasks,
  markRead,
  receiveNotifications,
  retireConversation,
  retiredConversationDestination,
  takeHeldUpdates,
  taskStarted,
  taskStopped,
  withUpdates,
} from './service.ts';
import { type BackgroundStoragePort, configureBackgroundStorage, snapshot } from './store.ts';

class MemoryStorage implements BackgroundStoragePort {
  contents: string | null = null;
  writes = 0;
  read(): string | null {
    return this.contents;
  }
  async writeAtomic(contents: string): Promise<void> {
    this.contents = contents;
    this.writes++;
  }
}

const storage = new MemoryStorage();
configureBackgroundStorage(storage);
const published: Array<{ conversationId: string; type: string }> = [];
let resolveRun: ((value: { success: boolean; error?: string }) => void) | undefined;
let notifyRunStarted: (() => void) | undefined;
const runStarted = new Promise<void>((resolve) => {
  notifyRunStarted = resolve;
});
configureBackgroundPorts({
  isCallActive: () => false,
  announceUpdate: () => false,
  onCallEnded: () => undefined,
  runUpdate: () =>
    new Promise((resolve) => {
      resolveRun = resolve;
      notifyRunStarted?.();
    }),
  publish: (conversationId, event) => {
    published.push({ conversationId, type: event.type });
  },
  publishList: () => undefined,
  updateLabel: (title) => title,
});

const notification = `<task-notification><task-id>job-1</task-id><status>completed</status><summary>Agent "Research" completed</summary><result>Finished report</result></task-notification>`;

test('notification acceptance is durable and duplicate delivery is idempotent', async () => {
  assert.equal(await receiveNotifications('chat-1', [notification]), 1);
  await runStarted;
  assert.ok(storage.contents);
  assert.equal(JSON.parse(storage.contents!).version, 3);
  assert.equal(await receiveNotifications('chat-1', [notification]), 0);
  const updates = Object.values(snapshot().updates);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].delivery, 'inflight');
  assert.equal(updates[0].unread, true);
  resolveRun?.({ success: false, error: 'failed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Object.values(snapshot().updates)[0].delivery, 'held');
  assert.equal(withUpdates('chat-1', []).length, 1);
  const [claim] = await takeHeldUpdates('chat-1');
  assert.ok(claim.deliveryToken);
  assert.equal(await completeDelivery('chat-1', claim.id, claim.deliveryToken!), true);
  assert.equal(await completeDelivery('chat-1', claim.id, claim.deliveryToken!), false);
  await markRead('chat-1', [claim.id]);
  await markRead('chat-1', [claim.id]);
  assert.equal(snapshot().updates[claim.id].unread, false);
});

test('late worker notifications after a fork migrate to the destination exactly once', async () => {
  await taskStarted({
    conversationId: 'fork-source',
    mode: 'voice-short',
    depth: 0,
    title: 'Research',
    toolResult:
      'Background task ID: fork-job\nAgent ID: worker-agent\nConversation ID: worker-conversation',
    worker: true,
  });
  await retireConversation('fork-source', 'fork-destination');
  assert.equal(retiredConversationDestination('fork-source'), 'fork-destination');
  assert.equal(
    snapshot().origins['fork-destination|fork-job'].workerConversationId,
    'worker-conversation'
  );

  const raw = notification
    .replace('job-1', 'fork-job')
    .replace(
      '</result>',
      '\nsubagent_type=research conversation_id=worker-conversation\nFork result</result>'
    );
  assert.equal(await receiveNotifications('fork-source', [raw]), 1);
  assert.equal(await receiveNotifications('fork-source', [raw]), 0);
  assert.equal(
    Object.values(snapshot().updates).filter(
      (update) => update.conversationId === 'fork-destination'
    ).length,
    1
  );
  assert.equal(
    Object.values(snapshot().updates).some((update) => update.conversationId === 'fork-source'),
    false
  );
});

test('a result accepted just before fork retirement keeps its update identity and report', async () => {
  await taskStarted({
    conversationId: 'accepted-source',
    mode: 'voice-short',
    depth: 0,
    title: 'Already done',
    toolResult:
      'Background task ID: accepted-job\nAgent ID: worker-agent\nConversation ID: worker-accepted',
    worker: true,
  });
  const raw = notification
    .replace('job-1', 'accepted-job')
    .replace(
      '</result>',
      '\nsubagent_type=research conversation_id=worker-accepted\nSaved report</result>'
    );
  assert.equal(await receiveNotifications('accepted-source', [raw]), 1);
  const [before] = Object.values(snapshot().updates).filter(
    (update) => update.conversationId === 'accepted-source'
  );
  assert.ok(before);
  await retireConversation('accepted-source', 'accepted-destination');
  assert.deepEqual(snapshot().updates[before.id], {
    ...before,
    conversationId: 'accepted-destination',
  });
});

test('archive tombstones suppress late results without creating archived updates', async () => {
  await taskStarted({
    conversationId: 'archive-source',
    mode: 'voice-short',
    depth: 0,
    title: 'Research',
    toolResult:
      'Background task ID: archive-job\nAgent ID: worker-agent\nConversation ID: worker-archive',
    worker: true,
  });
  const publishStart = published.length;
  await retireConversation('archive-source');
  assert.equal(retiredConversationDestination('archive-source'), null);
  const raw = notification.replace('job-1', 'archive-job');
  assert.equal(await receiveNotifications('archive-source', [raw]), 0);
  assert.equal(
    Object.values(snapshot().updates).some((update) => update.conversationId === 'archive-source'),
    false
  );
  assert.equal(
    published.slice(publishStart).some((event) => event.conversationId === 'archive-source'),
    false
  );
});

test('forking a fork compresses retired routes and preserves source dedupe keys', async () => {
  await retireConversation('fork-destination', 'fork-final');
  assert.equal(retiredConversationDestination('fork-source'), 'fork-final');
  assert.equal(retiredConversationDestination('fork-destination'), 'fork-final');
  assert.ok(snapshot().seen.some((fingerprint) => fingerprint.startsWith('fork-source|fork-job|')));
});

test('background commands publish their start and cancellation persists without a native callback', async () => {
  const first = published.length;
  await taskStarted({
    conversationId: 'command-chat',
    mode: 'text',
    depth: 0,
    title: 'Screenshot',
    toolResult: 'Command running in background with ID: bash_1',
    worker: false,
  });
  assert.ok(
    published
      .slice(first)
      .some((event) => event.conversationId === 'command-chat' && event.type === 'task')
  );
  await taskStopped('command-chat', {
    id: 'bash_1',
    title: 'Screenshot',
    status: 'running',
    kind: 'command',
  });
  const tasks = listTasks('command-chat', []);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'bash_1');
  assert.equal(tasks[0].status, 'cancelled');
  assert.equal(tasks[0].kind, 'command');
  assert.ok(tasks[0].updateId);
  assert.equal(withUpdates('command-chat', []).length, 1);
  assert.equal(snapshot().origins['command-chat|bash_1'], undefined);
  await receiveNotifications('command-chat', [notification.replace('job-1', 'bash_1')]);
  assert.equal(listTasks('command-chat', []).length, 1);
});

test('natively delivered results decorate their history row without waking another reply or duplicating the notice', async () => {
  const id = 'native-result-chat';
  const previousRun = resolveRun;
  await taskStarted({ conversationId: id, mode: 'text', depth: 0, title: '🧮 Multiplication', worker: true,
    toolResult: 'Task running in background with task ID: task_7' });
  await receiveNotifications(id, [notification.replace('job-1', 'task_7')], { deliveredNatively: true });
  const update = Object.values(snapshot().updates).find((u) => u.conversationId === id)!;
  assert.equal(update.delivery, 'delivered');
  const before = { id: 'launch', role: 'assistant' as const, text: 'Launched.' };
  const after = { id: 'answer', role: 'assistant' as const, text: 'The result.' };
  const rows = withUpdates(id, [before,
    { id: 'notice', role: 'event', kind: 'task_result', taskId: 'task_7', text: 'Native title' }, after]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0], before);
  assert.equal(rows[2], after);
  assert.equal(rows[1].role, 'event');
  assert.deepEqual(rows[1], { id: 'notice', role: 'event', kind: 'task_result', taskId: 'task_7',
    text: '🧮 Multiplication', updateId: update.id, status: 'completed', detail: 'Finished report', unread: false });
  assert.equal(resolveRun, previousRun);
});

test('Letta execution time is saved once and reaches both the feed and panel', async () => {
  const conversationId = 'timed-agent-chat';
  await taskStarted({ conversationId, mode: 'text', depth: 0, title: '🧮 Multiplication', worker: true,
    toolResult: 'Task running in background with task ID: timed-worker' });
  const raw = notification.replace('job-1', 'timed-worker').replace('</task-notification>', '<usage>duration_ms: 92000</usage></task-notification>');
  await receiveNotifications(conversationId, [raw], { deliveredNatively: true });
  const update = Object.values(snapshot().updates).find((u) => u.conversationId === conversationId)!;
  assert.equal(update.durationMs, 92000);
  assert.equal(listTasks(conversationId, [])[0].durationMs, 92000);
  const rows = withUpdates(conversationId, [{ id: 'native-notice', role: 'event', kind: 'task_result', taskId: 'timed-worker', text: 'Native' }]);
  assert.equal(rows[0].role === 'event' && rows[0].durationMs, 92000);
  assert.equal(JSON.parse(storage.contents!).updates[update.id].durationMs, 92000);
  await receiveNotifications(conversationId, [raw], { deliveredNatively: true });
  assert.equal(snapshot().updates[update.id].durationMs, 92000);
  await receiveNotifications('unknown-agent-start', [notification.replace('job-1', 'unknown-start')], { deliveredNatively: true });
  assert.equal(listTasks('unknown-agent-start', [])[0].durationMs, undefined);
});
