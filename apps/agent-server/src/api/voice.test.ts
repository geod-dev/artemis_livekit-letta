import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundError } from '@artemis/core';
import { FakeClock } from '@artemis/core/testing';
import type { BackgroundUpdateRecord } from '@artemis/storage';
import type { BackgroundDeliveryService } from '../tasks/delivery.ts';
import { createCallSessions } from '../calls/call-sessions.ts';
import type { ConversationService, TurnOutcome, UpdateTurn, VoiceTurn } from '../conversations/service.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { TaskService } from '../tasks/task-service.ts';
import { createApp } from './app.ts';
import type { ApiDependencies } from './deps.ts';

/** Test double: `members` names what the test uses; anything else is absent. */
function fake<T>(members: Partial<T>): T {
  return members as T;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const TOKEN = 'dev-agent-server-token-change-me';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CONV = '00000000-0000-4000-8000-0000000000c1';
const UPD = '00000000-0000-4000-8000-0000000000a1';
const UPD_OTHER = '00000000-0000-4000-8000-0000000000a5';
const UPD_MISSING = '00000000-0000-4000-8000-0000000000a9';
const CALL_ID = 'call_0123456789abcdef0123456789abcdef';

interface Spoken {
  text: string;
  clientMessageId?: string;
  mode: string;
}

function harness() {
  const clock = new FakeClock();
  const calls = createCallSessions(clock);
  const spoken: Spoken[] = [];
  const updates: Array<{ id: string; mode: string; token: string }> = [];
  const completed: string[] = [];
  const outcome: TurnOutcome = { turnId: 'turn_1', status: 'completed', text: 'Hello there', callState: 'done' };

  const conversations = fake<ConversationService>({
    async require(id: string) {
      if (id === 'missing') throw new NotFoundError('Conversation');
      return { id, title: 'New chat', updatedAt: null };
    },
    async submitVoiceTurn(_id: string, turn: VoiceTurn) {
      spoken.push({ text: turn.text, ...(turn.clientMessageId ? { clientMessageId: turn.clientMessageId } : {}), mode: turn.mode() });
      turn.onText('Hello ');
      turn.onText('there');
      return { turnId: outcome.turnId, done: Promise.resolve(outcome) };
    },
    async submitUpdateTurn(_id: string, turn: UpdateTurn) {
      updates.push({ id: turn.update.id, mode: turn.mode(), token: turn.deliveryToken });
      turn.onText('Hello there');
      return { turnId: outcome.turnId, done: Promise.resolve(outcome) };
    },
  });

  const delivery = fake<BackgroundDeliveryService>({
    async claimQueued(_conversationId: string, updateId: string) {
      if (updateId !== UPD) return null;
      return { token: 'tok', update: fake<BackgroundUpdateRecord>({ id: UPD, title: 'Build', report: 'done' }) };
    },
    async complete(_conversationId: string, _token: string, turnId: string) {
      completed.push(turnId);
    },
    async markRead(_conversationId: string, ids: string[]) {
      return ids.length;
    },
  });

  const deps: ApiDependencies = {
    config: fake<ApiDependencies['config']>({ token: TOKEN }),
    conversations,
    tasks: fake<TaskService>({}),
    delivery,
    calls,
    events: fake<ConversationEventHub>({}),
    mcp: fake<ApiDependencies['mcp']>({}),
    clock,
    ready: async () => ({ storage: true, mcp: true, memory: false }),
  };
  return { app: createApp(deps), calls, spoken, updates, completed };
}

const completion = (app: ReturnType<typeof createApp>, body: unknown, callId?: string) =>
  app.request(`/v1/voice/conversations/${CONV}/chat/completions`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', ...(callId ? { 'x-voice-call-id': callId } : {}) },
    body: JSON.stringify(body),
  });

test('a voice completion streams the reply and closes the voice response on the call', async () => {
  const { app, calls, spoken } = harness();
  calls.openChannel(CONV, () => undefined, 'short');
  const response = await completion(app, { messages: [{ role: 'user', content: 'hey there', id: 'lk-1' }] }, CALL_ID);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const body = await response.text();
  assert.match(body, /"content":"Hello "/);
  assert.match(body, /"content":"there"/);
  assert.match(body, /"finish_reason":"stop"/);
  assert.ok(body.endsWith('data: [DONE]\n\n'));

  assert.deepEqual(spoken, [{ text: 'hey there', clientMessageId: 'lk-1', mode: 'voice-short' }]);
  assert.equal(calls.active(CONV)!.next, 'end', 'a short call ends after a reply declared done');
});

test('a long call marks its voice responses as long', async () => {
  const { app, calls, spoken } = harness();
  calls.openChannel(CONV, () => undefined, 'long');
  await (await completion(app, { messages: [{ role: 'user', content: 'and then?' }] })).text();
  assert.equal(spoken[0]!.mode, 'voice-long');
});

test('a voice completion re-sent by LiveKit is not submitted again', async () => {
  const { app, spoken } = harness();
  const request = () => completion(app, { messages: [{ role: 'user', content: 'once', id: 'lk-2' }] }, CALL_ID);
  await (await request()).text();
  const second = await (await request()).text();
  assert.equal(spoken.length, 1);
  assert.ok(second.endsWith('data: [DONE]\n\n'));
});

test('a voice completion validates its messages', async () => {
  const { app } = harness();
  const response = await completion(app, { messages: 'nope' });
  assert.equal(response.status, 400);
  assert.equal((await json(response)).code, 'invalid_messages');
});

test('an update is claimed, spoken and completed; a call ends through its listeners', async () => {
  const { app, calls, updates, completed } = harness();
  const ended: string[][] = [];
  calls.onEnded((_id, pending) => ended.push(pending));
  calls.openChannel(CONV, () => undefined, 'long');

  const spoken = await app.request(`/v1/voice/conversations/${CONV}/call/updates/${UPD}`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(spoken.status, 200);
  assert.equal(await spoken.text(), 'Hello there');
  assert.deepEqual(updates, [{ id: UPD, mode: 'voice-long', token: 'tok' }]);
  assert.deepEqual(completed, ['turn_1']);

  const missing = await app.request(`/v1/voice/conversations/${CONV}/call/updates/${UPD_MISSING}`, { method: 'POST', headers: AUTH });
  assert.equal(missing.status, 404);

  calls.announceUpdate(CONV, UPD_OTHER);
  const ended204 = await app.request(`/v1/voice/conversations/${CONV}/ended`, { method: 'POST', headers: AUTH });
  assert.equal(ended204.status, 204);
  assert.deepEqual(ended, [[UPD_OTHER]]);
});

test('the call state defaults to short and listen without a call', async () => {
  const { app } = harness();
  const response = await app.request(`/v1/voice/conversations/${CONV}/call/state`, { headers: AUTH });
  assert.deepEqual(await json(response), { mode: 'short', next: 'listen' });
});

test('updates are acknowledged with heard true only', async () => {
  const { app } = harness();
  const bad = await app.request(`/v1/voice/conversations/${CONV}/call/updates/${UPD}/ack`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ heard: 'yes' }),
  });
  assert.equal(bad.status, 400);
  const ok = await app.request(`/v1/voice/conversations/${CONV}/call/updates/${UPD}/ack`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ heard: true }),
  });
  assert.equal(ok.status, 204);
});
