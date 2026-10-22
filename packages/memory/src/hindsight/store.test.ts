import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { HindsightMemoryStore } from './index.ts';

interface Captured {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

type Reply = { status?: number; body: unknown };

/**
 * Replaces `globalThis.fetch` (the Hindsight client resolves it per request) with a
 * scripted responder and records every request it receives. No network.
 */
function fakeFetch(t: TestContext, respond: (captured: Captured) => Reply = () => ({ body: {} })): Captured[] {
  const calls: Captured[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.text();
    const captured: Captured = {
      method: request.method,
      path: new URL(request.url).pathname,
      headers: request.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    };
    calls.push(captured);
    const reply = respond(captured);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

function store(overrides: Partial<ConstructorParameters<typeof HindsightMemoryStore>[0]> = {}): HindsightMemoryStore {
  return new HindsightMemoryStore({
    baseUrl: 'http://hindsight:8888',
    bankId: 'artemis',
    apiKey: 'secret',
    ...overrides,
  });
}

test('ensureReady creates or updates the bank with its missions', async (t) => {
  const calls = fakeFetch(t);
  await store({ retainMission: 'Extract preferences.', reflectMission: 'Frame answers.' }).ensureReady();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'PUT');
  assert.equal(calls[0]?.path, '/v1/default/banks/artemis');
  assert.equal(calls[0]?.headers.get('authorization'), 'Bearer secret');
  assert.deepEqual(calls[0]?.body, {
    retain_mission: 'Extract preferences.',
    reflect_mission: 'Frame answers.',
  });
});

test('ensureReady without missions sends no mission fields', async (t) => {
  const calls = fakeFetch(t);
  await store().ensureReady();
  assert.deepEqual(calls[0]?.body, {});
});

test('retain appends one transcript item under the conversation document with the operation id', async (t) => {
  const calls = fakeFetch(t, () => ({
    body: { success: true, bank_id: 'artemis', items_count: 1, async: true, operation_id: 'op-1' },
  }));

  const result = await store().retain({
    documentId: 'conversation:c1',
    operationId: 'op-1',
    turns: [
      { speaker: 'User', at: '2026-10-22T09:00:00Z', text: 'I moved to Lyon.' },
      { speaker: 'Assistant', at: '2026-10-22T09:00:05Z', text: 'Noted.' },
    ],
    context: 'Text conversation between User and the assistant.',
    timestamp: '2026-10-22T09:00:05Z',
    metadata: { conversation_id: 'c1' },
    tags: ['user:me'],
  });

  assert.deepEqual(result, { operationId: 'op-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/v1/default/banks/artemis/memories');
  assert.deepEqual(calls[0]?.body, {
    items: [
      {
        content: 'User (2026-10-22T09:00:00Z): I moved to Lyon.\nAssistant (2026-10-22T09:00:05Z): Noted.',
        timestamp: '2026-10-22T09:00:05Z',
        context: 'Text conversation between User and the assistant.',
        metadata: { conversation_id: 'c1' },
        document_id: 'conversation:c1',
        tags: ['user:me'],
        update_mode: 'append',
      },
    ],
    async: true,
    operation_id: 'op-1',
  });
});

test('retain rejects when Hindsight does not accept the batch', async (t) => {
  fakeFetch(t, () => ({ body: { success: false, bank_id: 'artemis', items_count: 0, async: true } }));
  await assert.rejects(
    store().retain({
      documentId: 'conversation:c1',
      operationId: 'op-2',
      turns: [{ speaker: 'User', at: '2026-10-22T09:00:00Z', text: 'hi' }],
      context: 'ctx',
      timestamp: '2026-10-22T09:00:00Z',
    }),
    /rejected retain operation op-2/,
  );
});

test('retain surfaces HTTP errors so the outbox can retry', async (t) => {
  fakeFetch(t, () => ({ status: 500, body: { detail: 'boom' } }));
  await assert.rejects(
    store().retain({
      documentId: 'conversation:c1',
      operationId: 'op-3',
      turns: [{ speaker: 'User', at: '2026-10-22T09:00:00Z', text: 'hi' }],
      context: 'ctx',
      timestamp: '2026-10-22T09:00:00Z',
    }),
  );
});

test('recall maps results to MemoryFact and drops unknown fact types', async (t) => {
  const calls = fakeFetch(t, () => ({
    body: {
      results: [
        {
          id: 'm1',
          text: 'User prefers meetings after 10am.',
          type: 'observation',
          mentioned_at: '2026-10-01T08:00:00Z',
          occurred_start: null,
        },
        {
          id: 'm2',
          text: "User's daughter is named Lea.",
          type: 'world',
          occurred_start: '2026-09-12T00:00:00Z',
          occurred_end: '2026-09-12T23:59:59Z',
          mentioned_at: null,
        },
        { id: 'm3', text: 'Something else.', type: 'mental_model' },
      ],
    },
  }));

  const result = await store().recall({
    query: 'Where does the user live?',
    budget: 'mid',
    maxTokens: 1500,
    queryTimestamp: '2026-10-22T09:00:00Z',
  });

  assert.deepEqual(result, {
    facts: [
      { id: 'm1', text: 'User prefers meetings after 10am.', type: 'observation', mentionedAt: '2026-10-01T08:00:00Z' },
      { id: 'm2', text: "User's daughter is named Lea.", type: 'world', occurredAt: '2026-09-12T00:00:00Z' },
    ],
  });
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.path, '/v1/default/banks/artemis/memories/recall');
  assert.deepEqual(calls[0]?.body, {
    query: 'Where does the user live?',
    types: ['world', 'experience', 'observation'],
    prefer_observations: true,
    budget: 'mid',
    max_tokens: 1500,
    query_timestamp: '2026-10-22T09:00:00Z',
    include: {},
  });
});

test('recall forwards tags and the high budget', async (t) => {
  const calls = fakeFetch(t, () => ({ body: { results: [] } }));
  const result = await store().recall({
    query: 'q',
    budget: 'high',
    maxTokens: 3000,
    queryTimestamp: '2026-10-22T09:00:00Z',
    tags: ['user:me'],
  });
  assert.deepEqual(result, { facts: [] });
  assert.equal(calls[0]?.body?.budget, 'high');
  assert.deepEqual(calls[0]?.body?.tags, ['user:me']);
});

test('healthy is true when /version answers and false when it fails', async (t) => {
  const calls = fakeFetch(t, () => ({ body: { version: '1.1.0' } }));
  assert.equal(await store().healthy(), true);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.path, '/version');

  fakeFetch(t, () => ({ status: 503, body: { detail: 'down' } }));
  assert.equal(await store().healthy(), false);
});

test('healthy is false when the server is unreachable', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  assert.equal(await store().healthy(), false);
});
