import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Logger, systemClock } from '@artemis/core';
import type { BackgroundUpdateRecord } from '@artemis/storage';
import { EphemeralStorage } from '@artemis/storage/testing';
import { createCallSessions } from '../../calls/call-sessions.ts';
import { createBackgroundDelivery } from '../../tasks/delivery.ts';
import type { TurnSubmission } from '../../turns/types.ts';
import { RecordingHub, silentLogger } from '../../../test/workers-support.ts';
import { TurnPersistence } from './turn-persistence.ts';
import type { TurnState } from './turn-state.ts';

const CONVERSATION = 'conv_persist';

const submission: TurnSubmission = { kind: 'user', modality: 'text', mode: 'text', effort: 'medium', text: 'hello' };

/** A conversation with one held update, claimed by a text turn `turnId` the way the worker does. */
async function setup(turnId: string, logger: Logger = silentLogger) {
  const storage = new EphemeralStorage();
  await storage.conversations.create(
    { id: CONVERSATION, title: null, titleSource: null },
    { systemPrompt: 'S', tools: [], templateId: 'system', templateHash: 'test' }
  );
  await storage.tasks.create({
    id: 'task_held',
    conversationId: CONVERSATION,
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
    startedAt: new Date().toISOString(),
  });
  await storage.updates.create({
    id: 'upd_held',
    conversationId: CONVERSATION,
    taskId: 'task_held',
    title: 'Held',
    status: 'completed',
    needsInput: false,
    report: 'done',
    durationMs: 1,
    depth: 0,
    delivery: 'held',
    unread: true,
    createdAt: new Date().toISOString(),
  });
  const hub = new RecordingHub();
  const delivery = createBackgroundDelivery({
    storage,
    hub,
    calls: createCallSessions(),
    clock: systemClock,
    logger,
    wake: () => {},
  });
  const persistence = new TurnPersistence({ storage, hub, delivery, clock: systemClock, logger });
  const claim = await delivery.claimHeld(CONVERSATION);
  const state: TurnState = {
    turnId,
    submission,
    signal: new AbortController().signal,
    controller: new AbortController(),
    token: claim.token,
    claimed: claim.updates as BackgroundUpdateRecord[],
    recorded: false,
    finished: false,
  };
  return { storage, hub, delivery, persistence, state };
}

test('a turn that fails is recorded as failed and its claimed updates are rolled back to held', async () => {
  const { storage, hub, delivery, persistence, state } = await setup('turn_fail');
  await persistence.open(state, CONVERSATION);
  assert.equal((await storage.turns.get('turn_fail'))?.status, 'running');
  assert.equal((await storage.updates.get('upd_held'))?.delivery, 'inflight');

  await persistence.abandon(state, CONVERSATION, 'model unavailable');

  const turn = await storage.turns.get('turn_fail');
  assert.equal(turn?.status, 'failed');
  assert.equal(turn?.error, 'model unavailable');
  assert.equal((await storage.updates.get('upd_held'))?.delivery, 'held');
  assert.equal(state.token, null);
  assert.ok(hub.events.some(({ event }) => event.type === 'turn_end' && event.success === false));
  assert.equal(await delivery.unreadCount(CONVERSATION), 1);
});

test('a failing rollback while a turn is abandoned is logged and does not fail the caller', async () => {
  const errors: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message) => {
      errors.push(message);
    },
    child: () => logger,
  };
  const { storage, delivery, persistence, state } = await setup('turn_rollback_fails', logger);
  await persistence.open(state, CONVERSATION);
  delivery.rollback = async () => {
    throw new Error('rollback store down');
  };

  await persistence.abandon(state, CONVERSATION, 'boom');

  assert.equal((await storage.turns.get('turn_rollback_fails'))?.status, 'failed');
  assert.deepEqual(errors, ['delivery rollback failed']);
});
