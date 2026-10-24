import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BusyError, NotFoundError, consoleLogger } from '@artemis/core';
import { FakeClock } from '@artemis/core/testing';
import type { McpServerRegistry } from '@artemis/mcp';
import type { TextTurnRequest } from '@artemis/contracts/agent-server';
import type { BackgroundDeliveryService } from '../tasks/delivery.ts';
import { createCallSessions } from '../calls/call-sessions.ts';
import { createVoiceService } from '../calls/voice-service.ts';
import type { ConversationService, TurnOutcome } from '../conversations/service.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { TaskPort } from '../tools/task-port.ts';
import { createApp } from './app.ts';
import type { ApiDependencies } from './deps.ts';

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** Test double: `members` names what the test uses; anything else is absent. */
function fake<T>(members: Partial<T>): T {
  return members as T;
}

const TOKEN = 'dev-agent-server-token-change-me';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CONV = '00000000-0000-4000-8000-0000000000c1';
const MSG = '00000000-0000-4000-8000-0000000000e1';
const ATTACHED = 'data/attachments/00000000-0000-4000-8000-0000000000f1/notes.txt';

function harness(options: { memory?: boolean } = {}) {
  const clock = new FakeClock();
  const turns: TextTurnRequest[] = [];
  const state: { submitError: Error | null; outcome: TurnOutcome } = {
    submitError: null,
    outcome: { turnId: 'turn_1', status: 'completed', text: 'Hello there', callState: 'done' },
  };
  const conversations = fake<ConversationService>({
    async require(id: string) {
      if (id === 'missing') throw new NotFoundError('Conversation');
      return { id, title: 'New chat', updatedAt: null };
    },
    async submitTurn(_id: string, request: TextTurnRequest) {
      if (state.submitError) throw state.submitError;
      turns.push(request);
      return { turnId: 'turn_1', done: Promise.resolve(state.outcome) };
    },
    async rewind() {
      return { attachments: [ATTACHED] };
    },
  });
  const mcp = fake<McpServerRegistry>({ setManaged: async () => undefined });
  const calls = createCallSessions(clock);
  const delivery = fake<BackgroundDeliveryService>({});
  const deps: ApiDependencies = {
    token: TOKEN,
    conversations,
    tasks: fake<TaskPort>({}),
    delivery,
    calls,
    voice: createVoiceService({ conversations, calls, delivery, logger: consoleLogger('test', { level: 'error' }) }),
    events: fake<ConversationEventHub>({}),
    mcp,
    clock,
    logger: consoleLogger('test', { level: 'error' }),
    ready: async () => ({ storage: true, mcp: true, memory: options.memory ?? false }),
  };
  return { app: createApp(deps), turns, state, deps };
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

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

test('a text turn is accepted with 202 and handed to the conversation service', async () => {
  const { app, turns } = harness();
  const response = await post(app, `/v1/conversations/${CONV}/turns`, { text: 'hi', effort: 'high', clientMessageId: 'cm1' });
  assert.equal(response.status, 202);
  assert.deepEqual(await json(response), { accepted: true, turnId: 'turn_1' });
  assert.deepEqual(turns, [{ text: 'hi', effort: 'high', clientMessageId: 'cm1' }]);
});

test('errors map to their status and code', async () => {
  const { app, state } = harness();

  const missing = await post(app, '/v1/conversations/missing/turns', { text: 'hi' });
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).code, 'not_found');

  state.submitError = new BusyError();
  const busy = await post(app, `/v1/conversations/${CONV}/turns`, { text: 'hi' });
  assert.equal(busy.status, 429);
  assert.equal((await json(busy)).code, 'busy');
  state.submitError = null;

  const empty = await post(app, `/v1/conversations/${CONV}/turns`, { text: '   ' });
  assert.equal(empty.status, 400);
  const badEffort = await post(app, `/v1/conversations/${CONV}/turns`, { text: 'hi', effort: 'extreme' });
  assert.equal(badEffort.status, 400);
});

test('attachments are checked before the turn is created, and only known fields are kept', async () => {
  const { app, turns } = harness();
  const path = `/v1/conversations/${CONV}/turns`;

  const notAnObject = await post(app, path, { text: 'hi', attachments: ['data/attachments/a.txt'] });
  assert.equal(notAnObject.status, 400);
  assert.equal((await json(notAnObject)).code, 'invalid_field');

  const badKind = await post(app, path, { text: 'hi', attachments: [{ kind: 'video', path: 'data/a', name: 'a' }] });
  assert.equal(badKind.status, 400);

  const badSize = await post(app, path, { text: 'hi', attachments: [{ kind: 'file', path: 'data/a', name: 'a', size: '3' }] });
  assert.equal(badSize.status, 400);

  const tooMany = await post(app, path, {
    text: 'hi',
    attachments: Array.from({ length: 21 }, () => ({ kind: 'file', path: 'data/a', name: 'a' })),
  });
  assert.equal(tooMany.status, 400);
  assert.deepEqual(turns, [], 'no rejected request reaches the service');

  const accepted = await post(app, path, {
    text: '',
    attachments: [{ kind: 'image', path: ATTACHED, name: 'notes.txt', mimeType: 'image/png', size: 3, extra: 'dropped' }],
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(turns, [
    {
      text: '',
      attachments: [{ kind: 'image', path: ATTACHED, name: 'notes.txt', mimeType: 'image/png', size: 3 }],
    },
  ]);
});

test('rewinding a message answers the attachments that remain', async () => {
  const { app } = harness();
  const response = await app.request(`/v1/conversations/${CONV}/messages/${MSG}`, { method: 'DELETE', headers: AUTH });
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { attachments: [ATTACHED] });
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

test('managed MCP servers must be objects with string names, otherwise 400', async () => {
  const { app } = harness();
  const put = (body: unknown) =>
    app.request('/v1/mcp/managed', {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  for (const servers of [{}, [null], ['device'], [{ url: 'http://x' }]]) {
    const response = await put({ servers });
    assert.equal(response.status, 400, JSON.stringify(servers));
    assert.equal((await json(response)).code, 'invalid_mcp_servers');
  }
  assert.equal((await put({ servers: [] })).status, 204);
});
