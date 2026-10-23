import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BusyError, NotFoundError } from '@artemis/core';
import type { TurnOutcome, TurnSubmission } from '../workers/types.ts';
import type { AgentServerConfig } from '../config.ts';
import type { BackgroundDeliveryService } from '../background/delivery.ts';
import type { ConversationService } from '../conversations/service.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { TaskService } from '../tasks/task-service.ts';
import type { WorkerSupervisor } from '../workers/supervisor.ts';
import { LocalCallSessions } from '../calls/call-sessions.ts';
import { FakeClock } from '../memory/test-support.ts';
import { createApp, type ApiDependencies } from './app.ts';

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const TOKEN = 'dev-agent-server-token-change-me';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CONV = '00000000-0000-4000-8000-0000000000c1';
const UPD = '00000000-0000-4000-8000-0000000000a1';
const UPD_OTHER = '00000000-0000-4000-8000-0000000000a5';
const UPD_MISSING = '00000000-0000-4000-8000-0000000000a9';

function harness(options: { memory?: boolean } = {}) {
  const clock = new FakeClock();
  const calls = new LocalCallSessions(clock);
  const submitted: TurnSubmission[] = [];
  const state: { submitError: Error | null; outcome: TurnOutcome; updatesCompleted: string[] } = {
    submitError: null,
    outcome: { turnId: 'turn_1', status: 'completed', text: 'Hello there', callState: 'done' },
    updatesCompleted: [],
  };
  const worker = {
    submit(input: TurnSubmission) {
      if (state.submitError) throw state.submitError;
      submitted.push(input);
      input.onText?.('Hello ');
      input.onText?.('there');
      return { turnId: 'turn_1', done: Promise.resolve(state.outcome) };
    },
    cancel: () => true,
  };
  const deps: ApiDependencies = {
    config: { token: TOKEN } as unknown as AgentServerConfig,
    conversations: {
      async require(id: string) {
        if (id === 'missing') throw new NotFoundError('Conversation');
        return { id };
      },
    } as unknown as ConversationService,
    supervisor: {
      async mainAgent() {
        return worker;
      },
      peekMainAgent: () => worker,
    } as unknown as WorkerSupervisor,
    tasks: {} as TaskService,
    delivery: {
      async claimQueued(_conversationId: string, updateId: string) {
        return updateId === UPD
          ? { token: 'tok', update: { id: UPD, title: 'Build', report: 'done' } }
          : null;
      },
      async complete(_conversationId: string, _token: string, turnId: string) {
        state.updatesCompleted.push(turnId);
      },
      async rollback() {},
      async markRead(_conversationId: string, ids: string[]) {
        return ids.length;
      },
    } as unknown as BackgroundDeliveryService,
    calls,
    events: {} as ConversationEventHub,
    mcp: {} as ApiDependencies['mcp'],
    ready: async () => ({ storage: true, mcp: true, memory: options.memory ?? false }),
  };
  return { app: createApp(deps), calls, submitted, state, deps };
}

test('health is open and ready reports degraded memory without failing', async () => {
  const { app } = harness({ memory: false });
  assert.equal((await app.request('/health')).status, 200);
  const ready = await app.request('/ready');
  assert.equal(ready.status, 200);
  assert.deepEqual(await json(ready), { status: 'degraded', storage: true, mcp: true, memory: false });
});

test('ready is unavailable without storage', async () => {
  const { deps } = harness();
  const app = createApp({ ...deps, ready: async () => ({ storage: false, mcp: false, memory: false }) });
  const response = await app.request('/ready');
  assert.equal(response.status, 503);
  assert.equal((await json(response)).status, 'unavailable');
});

test('the v1 API requires the bearer token', async () => {
  const { app } = harness();
  const missing = await app.request('/v1/mcp');
  assert.equal(missing.status, 401);
  assert.equal((await json(missing)).error, 'Unauthorized');
  const wrong = await app.request('/v1/mcp', { headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
});

test('a text turn is accepted with 202 and submitted as a text turn', async () => {
  const { app, submitted } = harness();
  const response = await app.request(`/v1/conversations/${CONV}/turns`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi', effort: 'high', clientMessageId: 'cm1' }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await json(response), { accepted: true, turnId: 'turn_1' });
  assert.equal(submitted[0]!.modality, 'text');
  assert.equal(submitted[0]!.mode, 'text');
  assert.equal(submitted[0]!.effort, 'high');
  assert.equal(submitted[0]!.clientMessageId, 'cm1');
});

test('errors map to their status and code', async () => {
  const { app, state } = harness();
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const missing = await post('/v1/conversations/missing/turns', { text: 'hi' });
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).code, 'not_found');

  state.submitError = new BusyError();
  const busy = await post(`/v1/conversations/${CONV}/turns`, { text: 'hi' });
  assert.equal(busy.status, 429);
  assert.equal((await json(busy)).code, 'busy');
  state.submitError = null;

  const empty = await post(`/v1/conversations/${CONV}/turns`, { text: '   ' });
  assert.equal(empty.status, 400);
  const badEffort = await post(`/v1/conversations/${CONV}/turns`, { text: 'hi', effort: 'extreme' });
  assert.equal(badEffort.status, 400);
});

test('a voice completion streams the reply and closes the voice response on the call', async () => {
  const { app, calls, submitted } = harness();
  calls.openChannel(CONV, () => undefined, 'short');
  const response = await app.request(`/v1/voice/conversations/${CONV}/chat/completions`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', 'x-voice-call-id': 'call-x' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hey there', id: 'lk-1' }] }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const body = await response.text();
  assert.match(body, /"content":"Hello "/);
  assert.match(body, /"content":"there"/);
  assert.match(body, /"finish_reason":"stop"/);
  assert.ok(body.endsWith('data: [DONE]\n\n'));

  assert.equal(submitted[0]!.modality, 'voice');
  assert.equal(submitted[0]!.mode, 'voice-short');
  assert.equal(submitted[0]!.text, 'hey there');
  assert.equal(submitted[0]!.clientMessageId, 'lk-1');
  assert.equal(calls.active(CONV)!.next, 'end', 'a short call ends after a reply declared done');
});

test('a voice completion re-sent by LiveKit is not submitted again', async () => {
  const { app, submitted } = harness();
  const request = () =>
    app.request(`/v1/voice/conversations/${CONV}/chat/completions`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json', 'x-voice-call-id': 'call-dedup' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'once', id: 'lk-2' }] }),
    });
  await (await request()).text();
  const second = await (await request()).text();
  assert.equal(submitted.length, 1);
  assert.ok(second.endsWith('data: [DONE]\n\n'));
});

test('a voice completion validates its messages', async () => {
  const { app } = harness();
  const response = await app.request(`/v1/voice/conversations/${CONV}/chat/completions`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: 'nope' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await json(response)).code, 'invalid_messages');
});

test('an update is claimed, spoken and completed; a call ends through its listeners', async () => {
  const { app, calls, state } = harness();
  const ended: string[][] = [];
  calls.onEnded((_id, pending) => ended.push(pending));
  calls.openChannel(CONV, () => undefined, 'long');

  const spoken = await app.request(`/v1/voice/conversations/${CONV}/call/updates/${UPD}`, {
    method: 'POST',
    headers: AUTH,
  });
  assert.equal(spoken.status, 200);
  assert.equal(await spoken.text(), 'Hello there');
  assert.deepEqual(state.updatesCompleted, ['turn_1']);

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

test('MCP settings require If-Match to save', async () => {
  const { app } = harness();
  const response = await app.request('/v1/mcp', {
    method: 'PUT',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ servers: [] }),
  });
  assert.equal(response.status, 428);
});
