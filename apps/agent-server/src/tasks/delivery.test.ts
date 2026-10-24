import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Logger, systemClock } from '@artemis/core';
import type { BackgroundUpdateRecord } from '@artemis/storage';
import { EphemeralStorage } from '@artemis/storage/testing';
import { silentLogger } from '../../test/workers-support.ts';
import { createCallSessions } from '../calls/call-sessions.ts';
import { ConversationEventHub } from '../events/hub.ts';
import { createBackgroundDelivery } from './delivery.ts';

function taskFor(id: string, conversationId: string) {
  return {
    id,
    conversationId,
    kind: 'agent' as const,
    status: 'completed' as const,
    title: id,
    prompt: 'p',
    subagentType: 'general-purpose',
    command: null,
    cwd: null,
    outputPath: null,
    needsInput: false,
    originMode: 'text' as const,
    originTurnId: null,
    originToolCallId: null,
    parentTaskId: null,
    resumedFromTaskId: null,
    depth: 0,
    model: null,
    startedAt: new Date().toISOString(),
  };
}

test('the event rows of a conversation hold only the updates not yet delivered', async () => {
  const storage = new EphemeralStorage();
  const conversationId = 'conv_rows';
  await storage.conversations.create(
    { id: conversationId, title: null, titleSource: null },
    { systemPrompt: 'S', tools: [], templateId: 'system', templateHash: 'test' }
  );
  for (const [taskId, delivery] of [
    ['task_old', 'delivered'],
    ['task_new', 'held'],
  ] as const) {
    await storage.tasks.create(taskFor(taskId, conversationId));
    await storage.updates.create({
      id: `upd_${taskId}`,
      conversationId,
      taskId,
      title: taskId,
      status: 'completed',
      needsInput: false,
      report: 'done',
      durationMs: 1,
      depth: 0,
      delivery,
      unread: true,
      createdAt: new Date().toISOString(),
    });
  }

  const delivery = createBackgroundDelivery({
    storage,
    hub: new ConversationEventHub(),
    calls: createCallSessions(),
    clock: systemClock,
    logger: silentLogger,
    wake: () => {},
  });
  const rows = await delivery.eventRows(conversationId);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['upd_task_new']
  );
});

async function createConversation(storage: EphemeralStorage, conversationId: string): Promise<void> {
  await storage.conversations.create(
    { id: conversationId, title: null, titleSource: null },
    { systemPrompt: 'S', tools: [], templateId: 'system', templateHash: 'test' }
  );
}

async function seedUpdate(
  storage: EphemeralStorage,
  conversationId: string,
  updateId: string,
  delivery: BackgroundUpdateRecord['delivery'],
  unread = false
): Promise<void> {
  const taskId = `task_${updateId}`;
  await storage.tasks.create(taskFor(taskId, conversationId));
  await storage.updates.create({
    id: updateId,
    conversationId,
    taskId,
    title: taskId,
    status: 'completed',
    needsInput: false,
    report: 'done',
    durationMs: 1,
    depth: 0,
    delivery,
    unread,
    createdAt: new Date().toISOString(),
  });
}

/** A logger that keeps its error entries for assertions. */
function capturingLogger(): { logger: Logger; errors: Array<{ message: string; fields?: Record<string, unknown> }> } {
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message, fields) => {
      errors.push({ message, fields });
    },
    child: () => logger,
  };
  return { logger, errors };
}

function deliveryFor(storage: EphemeralStorage, logger: Logger) {
  return createBackgroundDelivery({
    storage,
    hub: new ConversationEventHub(),
    calls: createCallSessions(),
    clock: systemClock,
    logger,
    wake: () => {},
  });
}

test('claiming held updates and rolling the claim back returns them to held', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_claim');
  await seedUpdate(storage, 'conv_claim', 'upd_held', 'held');
  const delivery = deliveryFor(storage, capturingLogger().logger);

  const claim = await delivery.claimHeld('conv_claim');
  assert.deepEqual(
    claim.updates.map((update) => update.id),
    ['upd_held']
  );
  assert.equal((await storage.updates.get('upd_held'))?.delivery, 'inflight');

  await delivery.rollback('conv_claim', claim.token);
  assert.equal((await storage.updates.get('upd_held'))?.delivery, 'held');
});

test('markRead clears the unread updates it names', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_read');
  await seedUpdate(storage, 'conv_read', 'upd_one', 'held', true);
  await seedUpdate(storage, 'conv_read', 'upd_two', 'held', true);
  const delivery = deliveryFor(storage, capturingLogger().logger);
  assert.equal(await delivery.unreadCount('conv_read'), 2);

  assert.equal(await delivery.markRead('conv_read', ['upd_one']), 1);
  assert.equal(await delivery.unreadCount('conv_read'), 1);
});

test('a call end whose store fails logs the error and does not throw', async () => {
  const storage = new EphemeralStorage();
  await createConversation(storage, 'conv_call');
  await seedUpdate(storage, 'conv_call', 'upd_queued', 'queued');
  storage.updates.unqueue = async () => {
    throw new Error('store unavailable');
  };
  const { logger, errors } = capturingLogger();
  const delivery = deliveryFor(storage, logger);

  await delivery.callEnded('conv_call', ['upd_queued']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, 'call-end delivery failed');
  assert.equal(errors[0]?.fields?.conversationId, 'conv_call');
  assert.equal(errors[0]?.fields?.error, 'store unavailable');
});
