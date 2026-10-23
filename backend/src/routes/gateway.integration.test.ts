import { serve } from '@hono/node-server';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { AgentServerClient } from '../agent-server/client.ts';
import { type AppConfig, validateConfig } from '../assistant/config.ts';
import { createAuth } from '../auth.ts';
import { createConversationRoutes } from './conversations.ts';

const AGENT_TOKEN = 'gateway-integration-agent-token';
const PASSWORD = 'gateway-integration-password';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READY = { status: 'ok', storage: true, mcp: true, memory: true };
const SSE_EVENTS = [1, 2, 3, 4, 5].map(
  (seq) => `id: ${seq}\nevent: message\ndata: ${JSON.stringify({ seq, text: `évènement ${seq} 🚀 — fin` })}\n\n`
);

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface FakeAgentServer {
  url: string;
  received: Received[];
  /** Holds the event stream after its first event until a test releases it. */
  gate: Promise<void>;
  close(): Promise<void>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** A stand-in for the agent-server: records every request and answers like the real `/v1` API. */
async function startFakeAgentServer(): Promise<FakeAgentServer> {
  const received: Received[] = [];
  const fake: { gate: Promise<void> } = { gate: Promise.resolve() };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://agent.test').pathname;
    received.push({ method, url: req.url ?? '/', headers: req.headers, body });

    if (method === 'GET' && path === '/ready') return sendJson(res, 200, READY);
    if (req.headers.authorization !== `Bearer ${AGENT_TOKEN}`)
      return sendJson(res, 401, { error: 'Unauthorized', code: 'unauthorized' });

    if (method === 'POST' && path === '/v1/conversations') {
      const input = body.trim() ? (JSON.parse(body) as { title?: unknown }) : {};
      return sendJson(res, 201, {
        id: randomUUID(),
        title: typeof input.title === 'string' ? input.title : 'New conversation',
        updatedAt: null,
      });
    }
    if (method === 'GET' && path === '/v1/conversations') return sendJson(res, 200, []);

    const turn = /^\/v1\/conversations\/([^/]+)\/turns$/.exec(path);
    if (method === 'POST' && turn) {
      if (turn[1] === 'gone')
        return sendJson(res, 404, { error: 'Conversation not found', code: 'conversation_not_found' });
      return sendJson(res, 202, { accepted: true, turnId: randomUUID() });
    }

    const events = /^\/v1\/conversations\/([^/]+)\/events$/.exec(path);
    if (method === 'GET' && events) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(SSE_EVENTS[0]);
      await fake.gate;
      res.end(SSE_EVENTS.slice(1).join(''));
      return;
    }

    const conversation = /^\/v1\/conversations\/([^/]+)$/.exec(path);
    if (method === 'GET' && conversation) {
      const id = decodeURIComponent(conversation[1]);
      if (id === 'boom')
        return sendJson(res, 500, { error: 'The request could not be completed', requestId: 'upstream-500' });
      if (id === 'unavailable')
        return sendJson(res, 503, { error: 'The request could not be completed', requestId: 'upstream-503' });
      return sendJson(res, 200, { id, title: 'Chat', updatedAt: null });
    }

    return sendJson(res, 404, { error: 'Not found', code: 'not_found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    get gate() {
      return fake.gate;
    },
    set gate(value: Promise<void>) {
      fake.gate = value;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The backend's composition from server.ts: auth in front of the gateway routes, public health and readiness. */
function buildGateway(config: AppConfig): Hono {
  const agent = new AgentServerClient(config.agentServer);
  const app = createAuth(config.auth.password, config.auth.deviceToken);
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', (c) => agent.relay(c.req.raw, '/ready'));
  app.route('/api/conversations', createConversationRoutes(agent));
  return app;
}

let root: string;
let fake: FakeAgentServer;
let gateway: Server;
let origin: string;
let cookie: string;

/** A browser's request to the gateway: same origin, with the session cookie unless told otherwise. */
function browser(path: string, init: RequestInit = {}, { session = true } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Origin', origin);
  if (session) headers.set('Cookie', cookie);
  return fetch(`${origin}${path}`, { ...init, headers });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'artemis-gateway-integration-'));
  fake = await startFakeAgentServer();
  const config = validateConfig({
    AGENT_SERVER_URL: fake.url,
    AGENT_SERVER_TOKEN: AGENT_TOKEN,
    ARTEMIS_PASSWORD: PASSWORD,
    WORKSPACE_PATH: join(root, 'workspace'),
    ASSISTANT_DATA_ROOT: join(root, 'data'),
  });
  gateway = serve({ fetch: buildGateway(config).fetch, hostname: '127.0.0.1', port: 0 }) as Server;
  await once(gateway, 'listening');
  origin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  const login = await fetch(`${origin}/api/auth/login`, {
    ...json('POST', { password: PASSWORD }),
    headers: { 'Content-Type': 'application/json', Origin: origin },
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});

after(async () => {
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  await fake.close();
  await rm(root, { recursive: true, force: true });
});

test('creating a conversation reaches the agent-server with the bearer token and returns its 201 unchanged', async () => {
  const response = await browser('/api/conversations', json('POST', { title: 'Résumé 🚀' }));
  assert.equal(response.status, 201);
  assert.match(response.headers.get('Content-Type') ?? '', /application\/json/);
  const body = (await response.json()) as { id: string; title: string; updatedAt: null };
  assert.match(body.id, UUID);
  assert.deepEqual(body, { id: body.id, title: 'Résumé 🚀', updatedAt: null });

  const sent = fake.received.at(-1)!;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/v1/conversations');
  assert.equal(sent.headers.authorization, `Bearer ${AGENT_TOKEN}`);
  assert.match(sent.headers['content-type'] ?? '', /application\/json/);
  assert.equal(sent.headers.cookie, undefined, 'the browser session cookie must stay at the gateway');
  assert.deepEqual(JSON.parse(sent.body), { title: 'Résumé 🚀' });
});

test('creating a conversation without a body is relayed, with or without a JSON content type', async () => {
  const bare = await browser('/api/conversations', { method: 'POST' });
  assert.equal(bare.status, 201);
  assert.match(((await bare.json()) as { id: string }).id, UUID);
  assert.equal(fake.received.at(-1)!.body, '');

  const typed = await browser('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(typed.status, 201);
  assert.match(((await typed.json()) as { id: string }).id, UUID);
});

test('a message keeps its unicode, newlines and escapes when forwarded as a turn', async () => {
  const text = 'Café déjà vu — 日本語 🚀 👩🏽‍💻\nsecond line\r\n\tindented "quotes" \\ back\\slash end';
  const response = await browser(
    '/api/conversations/c-body/messages',
    json('POST', { text, effort: 'high', clientMessageId: 'client-é-1' })
  );
  assert.equal(response.status, 202);
  const accepted = (await response.json()) as { accepted: boolean; turnId: string };
  assert.equal(accepted.accepted, true);
  assert.match(accepted.turnId, UUID);

  const sent = fake.received.at(-1)!;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/v1/conversations/c-body/turns');
  assert.equal(sent.headers.authorization, `Bearer ${AGENT_TOKEN}`);
  const forwarded = JSON.parse(sent.body) as Record<string, unknown>;
  assert.equal(forwarded.text, text);
  assert.equal(forwarded.effort, 'high');
  assert.equal(forwarded.clientMessageId, 'client-é-1');
  assert.deepEqual(forwarded.attachments, []);
});

test('a long message crosses the gateway without truncation', async () => {
  const text = 'é🚀\n'.repeat(22_000) + 'the end';
  const response = await browser('/api/conversations/c-long/messages', json('POST', { text }));
  assert.equal(response.status, 202);
  const forwarded = JSON.parse(fake.received.at(-1)!.body) as { text: string };
  assert.equal(forwarded.text.length, text.length);
  assert.equal(forwarded.text, text);
});

test('agent-server errors keep their status and body, and the gateway keeps serving afterwards', async () => {
  const failed = await browser('/api/conversations/boom');
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), {
    error: 'The request could not be completed',
    requestId: 'upstream-500',
  });

  const unavailable = await browser('/api/conversations/unavailable');
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: 'The request could not be completed',
    requestId: 'upstream-503',
  });

  const missing = await browser('/api/conversations/gone/messages', json('POST', { text: 'hello' }));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Conversation not found', code: 'conversation_not_found' });

  const after = await browser('/api/conversations/c1');
  assert.equal(after.status, 200);
  assert.equal(((await after.json()) as { id: string }).id, 'c1');
});

test('server-sent events reach the browser byte for byte, before the agent-server finishes the stream', async () => {
  let release!: () => void;
  fake.gate = new Promise<void>((resolve) => (release = resolve));
  try {
    const response = await browser('/api/conversations/c-stream/events');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type') ?? '', /text\/event-stream/);
    assert.equal(response.headers.get('Cache-Control'), 'no-cache');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('\n\n')) {
      const { done, value } = await reader.read();
      assert.equal(done, false, 'the stream ended before its first event arrived');
      text += decoder.decode(value, { stream: true });
    }
    assert.equal(text, SSE_EVENTS[0], 'the first event must arrive while the agent-server still holds the stream');

    release();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    assert.equal(text, SSE_EVENTS.join(''));
  } finally {
    release();
    fake.gate = Promise.resolve();
  }
});

test('browser requests without a valid session get 401 and never reach the agent-server', async () => {
  const forwardedBefore = fake.received.length;

  const anonymous = await browser('/api/conversations', {}, { session: false });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: 'Unauthorized' });

  const anonymousPost = await browser('/api/conversations', json('POST', {}), { session: false });
  assert.equal(anonymousPost.status, 401);

  const anonymousMessage = await browser(
    '/api/conversations/c1/messages',
    json('POST', { text: 'hello' }),
    { session: false }
  );
  assert.equal(anonymousMessage.status, 401);

  const forged = await fetch(`${origin}/api/conversations/c1/events`, { headers: { Cookie: `${cookie}x` } });
  assert.equal(forged.status, 401);

  const agentTokenAsBrowser = await fetch(`${origin}/api/conversations`, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
  });
  assert.equal(agentTokenAsBrowser.status, 401);

  assert.equal(fake.received.length, forwardedBefore, 'no unauthenticated request may be forwarded');
});

test('a cross-site POST with a valid session is refused before it is forwarded', async () => {
  const forwardedBefore = fake.received.length;
  const response = await fetch(`${origin}/api/conversations`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Invalid origin' });
  assert.equal(fake.received.length, forwardedBefore);
});

test('readiness relays the agent-server answer, and health is answered by the gateway itself', async () => {
  const ready = await fetch(`${origin}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), READY);

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
});
