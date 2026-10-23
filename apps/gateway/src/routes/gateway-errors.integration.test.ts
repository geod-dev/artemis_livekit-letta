import { serve } from '@hono/node-server';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { AgentServerClient } from '../agent-server/client.ts';
import { type AppConfig, validateConfig } from '../assistant/config.ts';
import { createAuth } from '../auth.ts';
import { createConversationRoutes } from './conversations.ts';

const AGENT_TOKEN = 'gateway-errors-agent-token';
const PASSWORD = 'gateway-errors-password';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MASKED = 'The request could not be completed';

type Responder = (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Default answers of the agent-server stand-in; tests replace `respond` to inject a failure. */
const defaultRespond: Responder = (req, res) => {
  const path = new URL(req.url ?? '/', 'http://agent.test').pathname;
  if (req.headers.authorization !== `Bearer ${AGENT_TOKEN}`)
    return sendJson(res, 401, { error: 'Unauthorized', code: 'unauthorized' });
  if (req.method === 'POST' && path === '/v1/conversations')
    return sendJson(res, 201, { id: randomUUID(), title: 'New conversation', updatedAt: null });
  if (req.method === 'GET' && path === '/v1/conversations') return sendJson(res, 200, []);
  if (req.method === 'GET' && /^\/v1\/conversations\/[^/]+\/events$/.test(path)) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"seq":1}\n\n');
    // The agent-server dies in the middle of the stream.
    setTimeout(() => res.socket?.destroy(), 50);
    return;
  }
  return sendJson(res, 404, { error: 'Not found', code: 'not_found' });
};

interface FakeAgentServer {
  url: string;
  /** "METHOD path" of every request that reached the stand-in. */
  requests: string[];
  respond: Responder;
  close(): Promise<void>;
}

async function startFakeAgentServer(): Promise<FakeAgentServer> {
  const requests: string[] = [];
  const fake: { respond: Responder } = { respond: defaultRespond };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push(`${req.method} ${req.url}`);
    await fake.respond(req, res, Buffer.concat(chunks).toString('utf8'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get respond() {
      return fake.respond;
    },
    set respond(value: Responder) {
      fake.respond = value;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The backend's composition from server.ts: auth in front of the gateway routes. */
function buildGateway(config: AppConfig): Hono {
  const agent = new AgentServerClient(config.agentServer);
  const app = createAuth(config.auth.password, config.auth.deviceToken);
  app.route('/api/conversations', createConversationRoutes(agent));
  return app;
}

interface Session {
  origin: string;
  /** A browser request to the gateway, with a valid session and the gateway's origin. */
  session(path: string, init?: RequestInit): Promise<Response>;
}

/** Start a gateway pointed at `agentUrl` with `agentToken`, log in, run the test, then stop everything. */
async function withGateway<T>(agentUrl: string, agentToken: string, run: (gw: Session) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'artemis-gateway-errors-'));
  try {
    const config = validateConfig({
      AGENT_SERVER_URL: agentUrl,
      AGENT_SERVER_TOKEN: agentToken,
      ARTEMIS_PASSWORD: PASSWORD,
      WORKSPACE_PATH: join(root, 'workspace'),
      ASSISTANT_DATA_ROOT: join(root, 'data'),
    });
    const server = serve({ fetch: buildGateway(config).fetch, hostname: '127.0.0.1', port: 0 }) as Server;
    await once(server, 'listening');
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const login = await fetch(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      return await run({
        origin,
        session: (path, init = {}) => {
          const headers = new Headers(init.headers);
          headers.set('Origin', origin);
          headers.set('Cookie', cookie);
          return fetch(`${origin}${path}`, { ...init, headers });
        },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A loopback port that refuses connections: a listener that was opened and closed again. */
async function refusedPortUrl(): Promise<string> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

let fake: FakeAgentServer;

before(async () => {
  fake = await startFakeAgentServer();
});

beforeEach(() => {
  fake.respond = defaultRespond;
});

after(async () => {
  await fake?.close();
});

test('an agent-server that refuses connections yields 503 with a masked, stable error body', async (t) => {
  t.mock.method(console, 'error', () => {});
  const unreachable = await refusedPortUrl();
  await withGateway(unreachable, AGENT_TOKEN, async (gw) => {
    const response = await gw.session('/api/conversations', json('POST', { title: 'Hello' }));
    assert.equal(response.status, 503);
    assert.match(response.headers.get('Content-Type') ?? '', /application\/json/);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
    assert.equal(body.error, MASKED);
    assert.match(body.requestId as string, UUID);
  });
});

test('a hung agent-server does not hang the browser: the gateway answers 502 or 503 within 10 seconds', { timeout: 25_000 }, async (t) => {
  t.mock.method(console, 'error', () => {});
  // Accepts the request and never answers, like a wedged agent-server process.
  fake.respond = () => {};
  await withGateway(fake.url, AGENT_TOKEN, async (gw) => {
    const response = await gw.session('/api/conversations', {
      ...json('POST', { title: 'Slow' }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.ok([502, 503].includes(response.status), `expected 502 or 503, got ${response.status}`);
    assert.equal(response.headers.get('Content-Type')?.startsWith('application/json'), true);
    const body = (await response.json()) as { error: unknown };
    assert.equal(typeof body.error, 'string');
  });
});

test('a message over the body limit is refused with 413 and never reaches the agent-server', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withGateway(fake.url, AGENT_TOKEN, async (gw) => {
    const forwardedBefore = fake.requests.length;
    const response = await gw.session(
      '/api/conversations/c1/messages',
      json('POST', { text: 'a'.repeat(5 * 1024 * 1024) })
    );
    assert.equal(response.status, 413);
    assert.equal(fake.requests.length, forwardedBefore);
  });
});

test('an agent-server that dies mid-stream ends that event stream without taking the gateway down', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withGateway(fake.url, AGENT_TOKEN, async (gw) => {
    const response = await gw.session('/api/conversations/c-cut/events');
    assert.equal(response.status, 200);
    const decoder = new TextDecoder();
    let text = '';
    try {
      const reader = response.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // A cut stream may surface as a read error; the client then reconnects.
    }
    assert.match(text, /"seq":1/, 'events sent before the failure must reach the browser');

    const next = await gw.session('/api/conversations');
    assert.equal(next.status, 200);
    assert.deepEqual(await next.json(), []);
  });
});

test('an agent-server that rejects the gateway token is reported as a gateway failure, not as the browser being unauthenticated', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withGateway(fake.url, 'a-stale-gateway-token', async (gw) => {
    const response = await gw.session('/api/conversations');
    assert.ok(response.status >= 500 && response.status < 600, `expected a 5xx, got ${response.status}`);
    const body = (await response.json()) as { error: unknown };
    assert.equal(typeof body.error, 'string');
  });
});
