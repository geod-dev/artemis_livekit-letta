import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeDelivery,
  configureBackgroundPorts,
  markRead,
  receiveNotifications,
  retireConversation,
  retiredConversationDestination,
  taskStarted,
  takeHeldUpdates,
  withUpdates,
} from './service.ts';
import { snapshot, configureBackgroundStorage, type BackgroundStoragePort } from './store.ts';

class MemoryStorage implements BackgroundStoragePort {
  contents: string | null = null;
  writes = 0;
  read(): string | null { return this.contents; }
  async writeAtomic(contents: string): Promise<void> { this.contents = contents; this.writes++; }
}

const storage = new MemoryStorage();
configureBackgroundStorage(storage);
const published: Array<{ conversationId: string; type: string }> = [];
let resolveRun: ((value: { success: boolean; error?: string }) => void) | undefined;
let notifyRunStarted: (() => void) | undefined;
const runStarted = new Promise<void>((resolve) => { notifyRunStarted = resolve; });
configureBackgroundPorts({
  isCallActive: () => false,
  announceUpdate: () => false,
  onCallEnded: () => undefined,
  runUpdate: () => new Promise((resolve) => { resolveRun = resolve; notifyRunStarted?.(); }),
  publish: (conversationId, event) => { published.push({ conversationId, type: event.type }); },
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
    conversationId: 'fork-source', mode: 'voice-short', depth: 0, title: 'Research',
    toolResult: 'Background task ID: fork-job\nAgent ID: worker-agent\nConversation ID: worker-conversation', worker: true,
  });
  await retireConversation('fork-source', 'fork-destination');
  assert.equal(retiredConversationDestination('fork-source'), 'fork-destination');
  assert.equal(snapshot().origins['fork-destination|fork-job'].workerConversationId, 'worker-conversation');

  const raw = notification.replace('job-1', 'fork-job').replace('</result>', '\nsubagent_type=research conversation_id=worker-conversation\nFork result</result>');
  assert.equal(await receiveNotifications('fork-source', [raw]), 1);
  assert.equal(await receiveNotifications('fork-source', [raw]), 0);
  assert.equal(Object.values(snapshot().updates).filter((update) => update.conversationId === 'fork-destination').length, 1);
  assert.equal(Object.values(snapshot().updates).some((update) => update.conversationId === 'fork-source'), false);
});

test('a result accepted just before fork retirement keeps its update identity and report', async () => {
  await taskStarted({
    conversationId: 'accepted-source', mode: 'voice-short', depth: 0, title: 'Already done',
    toolResult: 'Background task ID: accepted-job\nAgent ID: worker-agent\nConversation ID: worker-accepted', worker: true,
  });
  const raw = notification.replace('job-1', 'accepted-job').replace('</result>', '\nsubagent_type=research conversation_id=worker-accepted\nSaved report</result>');
  assert.equal(await receiveNotifications('accepted-source', [raw]), 1);
  const [before] = Object.values(snapshot().updates).filter((update) => update.conversationId === 'accepted-source');
  assert.ok(before);
  await retireConversation('accepted-source', 'accepted-destination');
  assert.deepEqual(snapshot().updates[before.id], {
    ...before,
    conversationId: 'accepted-destination',
  });
});

test('archive tombstones suppress late results without creating archived updates', async () => {
  await taskStarted({
    conversationId: 'archive-source', mode: 'voice-short', depth: 0, title: 'Research',
    toolResult: 'Background task ID: archive-job\nAgent ID: worker-agent\nConversation ID: worker-archive', worker: true,
  });
  const publishStart = published.length;
  await retireConversation('archive-source');
  assert.equal(retiredConversationDestination('archive-source'), null);
  const raw = notification.replace('job-1', 'archive-job');
  assert.equal(await receiveNotifications('archive-source', [raw]), 0);
  assert.equal(Object.values(snapshot().updates).some((update) => update.conversationId === 'archive-source'), false);
  assert.equal(published.slice(publishStart).some((event) => event.conversationId === 'archive-source'), false);
});

test('forking a fork compresses retired routes and preserves source dedupe keys', async () => {
  await retireConversation('fork-destination', 'fork-final');
  assert.equal(retiredConversationDestination('fork-source'), 'fork-final');
  assert.equal(retiredConversationDestination('fork-destination'), 'fork-final');
  assert.ok(snapshot().seen.some((fingerprint) => fingerprint.startsWith('fork-source|fork-job|')));
});
