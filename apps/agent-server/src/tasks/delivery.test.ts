import assert from 'node:assert/strict';
import { test } from 'node:test';
import { systemClock } from '@artemis/core';
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
