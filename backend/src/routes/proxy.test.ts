import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentServerClient } from '../agent-server/client.ts';
import { config } from '../assistant/config.ts';
import type { McpServer } from '../chat-types.ts';
import { removeUnusedAttachment } from '../assistant/filesystem/attachment-retention.ts';
import { saveAttachment } from '../assistant/filesystem/workspace-adapter.ts';
import { createConversationRoutes } from './conversations.ts';
import { createMcpRoutes } from './mcp.ts';
import { createVoiceRoutes } from './voice.ts';

const AGENT_TOKEN = 'agent-server-test-token';
const VOICE_TOKEN = 'voice-agent-test-token';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const CONVERSATION = { id: 'c1', title: 'Chat', updatedAt: null };

interface Received {
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  body: string;
  headers: Headers;
}

/** A stand-in for the agent-server that records what the gateway sends and answers like the real API. */
async function fakeAgentServer() {
  const received: Received[] = [];
  const state: { messages: unknown[]; managed: unknown[] } = { messages: [], managed: [] };
  const app = new Hono();
  app.use('*', async (c, next) => {
    received.push({
      method: c.req.method,
      path: c.req.path,
      search: new URL(c.req.url).search,
      authorization: c.req.header('authorization') ?? null,
      body: await c.req.raw.clone().text(),
      headers: c.req.raw.headers,
    });
    if (c.req.path !== '/ready' && c.req.header('authorization') !== `Bearer ${AGENT_TOKEN}`)
      return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });
  app.get('/ready', (c) => c.json({ status: 'ok', storage: true, mcp: true, memory: true }));
  app.get('/v1/conversations', (c) => c.json([CONVERSATION]));
  app.get('/v1/conversations/missing', (c) =>
    c.json({ error: 'Conversation not found', code: 'conversation_not_found' }, 404)
  );
  app.get('/v1/conversations/:id/events', () =>
    new Response('data: {"type":"snapshot"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    })
  );
  app.get('/v1/conversations/:id/messages', (c) => c.json(state.messages));
  app.post('/v1/conversations/:id/turns', async (c) =>
    (await c.req.json<{ text: string }>()).text === 'busy'
      ? c.json({ error: 'Conversation is busy', code: 'busy' }, 429)
      : c.json({ accepted: true, turnId: 't1' }, 202)
  );
  app.delete('/v1/conversations/:id/messages/:messageId', (c) => {
    state.messages = [];
    return c.json({ conversation: { ...CONVERSATION, id: c.req.param('id') } });
  });
  app.delete('/v1/conversations/:id', () => new Response(null, { status: 204 }));
  app.get('/v1/mcp', (c) =>
    c.json(
      { revision: 'r1', servers: [], diagnostics: [], bridge: { servers: [], tools: 0, failures: {} } },
      200,
      { ETag: '"r1"' }
    )
  );
  app.put('/v1/mcp', (c) =>
    c.req.header('if-match') === '"stale"'
      ? c.json({ error: 'The MCP settings changed', code: 'revision_conflict' }, 412)
      : c.json({ revision: 'r2', servers: [], diagnostics: [], bridge: { servers: [], tools: 0, failures: {} } }, 200)
  );
  app.put('/v1/mcp/managed', async (c) => {
    state.managed = (await c.req.json<{ servers: unknown[] }>()).servers;
    return new Response(null, { status: 204 });
  });
  app.post('/v1/voice/conversations/:id/chat/completions', (c) =>
    new Response(
      `data: ${JSON.stringify({ call: c.req.header('x-voice-call-id') })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  );
  app.get('/v1/voice/conversations/:id/call/state', (c) => c.json({ mode: 'short', next: 'end' }));

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    state,
    close: async () => {
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The gateway's API routers, as startBackend mounts them, in front of a fake agent-server. */
async function fixture() {
  const previousRoot = config.workspace.dir;
  const previousVoiceToken = config.voiceGatewayToken;
  const root = await mkdtemp(join(tmpdir(), 'artemis-gateway-proxy-'));
  config.workspace.dir = root;
  config.voiceGatewayToken = VOICE_TOKEN;
  const agentServer = await fakeAgentServer();
  const agent = new AgentServerClient({ url: agentServer.url, token: AGENT_TOKEN });
  const app = new Hono();
  app.route('/api/conversations', createConversationRoutes(agent));
  app.route('/api/mcp', createMcpRoutes(agent));
  app.route('/api/voice', createVoiceRoutes(agent));
  return {
    app,
    agent,
    agentServer,
    root,
    close: async () => {
      config.workspace.dir = previousRoot;
      config.voiceGatewayToken = previousVoiceToken;
      await agentServer.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('reads keep their query string, status and error bodies, and send the agent-server token', async () => {
  const f = await fixture();
  try {
    const list = await f.app.request('https://gateway.test/api/conversations?limit=5');
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), [CONVERSATION]);
    const sent = f.agentServer.received.at(-1)!;
    assert.equal(sent.path, '/v1/conversations');
    assert.equal(sent.search, '?limit=5');
    assert.equal(sent.authorization, `Bearer ${AGENT_TOKEN}`);

    const missing = await f.app.request('https://gateway.test/api/conversations/missing');
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Conversation not found', code: 'conversation_not_found' });
  } finally {
    await f.close();
  }
});

test('server-sent events stream through the gateway', async () => {
  const f = await fixture();
  try {
    const response = await f.app.request('https://gateway.test/api/conversations/c1/events');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type') ?? '', /text\/event-stream/);
    assert.match(await response.text(), /"type":"snapshot"/);
  } finally {
    await f.close();
  }
});

test('a message references its uploads and goes to the agent-server as a turn', async () => {
  const f = await fixture();
  try {
    const upload = await saveAttachment(new File([PNG], 'photo.png', { type: 'image/png' }));
    const response = await f.app.request(
      'https://gateway.test/api/conversations/c1/messages',
      json('POST', {
        text: ' hello ',
        effort: 'xhigh',
        clientMessageId: 'client-1',
        attachments: [{ path: upload.path, name: 'photo.png', kind: 'image' }],
      })
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true, turnId: 't1' });
    const turn = f.agentServer.received.at(-1)!;
    assert.equal(turn.method, 'POST');
    assert.equal(turn.path, '/v1/conversations/c1/turns');
    const body = JSON.parse(turn.body);
    assert.equal(body.text, 'hello');
    assert.equal(body.effort, 'xhigh');
    assert.equal(body.clientMessageId, 'client-1');
    assert.deepEqual(body.attachments, [
      { path: upload.path, name: 'photo.png', kind: 'image', mimeType: 'image/png', size: PNG.length },
    ]);
    assert.equal(await removeUnusedAttachment(upload.path), false);

    const invalid = await f.app.request(
      'https://gateway.test/api/conversations/c1/messages',
      json('POST', { text: 'hello', effort: 'extreme' })
    );
    assert.equal(invalid.status, 400);
    assert.equal(f.agentServer.received.filter((r) => r.path.endsWith('/turns')).length, 1);
  } finally {
    await f.close();
  }
});

test('a refused turn does not keep its uploads', async () => {
  const f = await fixture();
  try {
    const upload = await saveAttachment(new File([PNG], 'photo.png', { type: 'image/png' }));
    const refused = await f.app.request('https://gateway.test/api/conversations/c1/messages', json('POST', {
      text: 'busy',
      attachments: [{ path: upload.path, name: 'photo.png', kind: 'image' }],
    }));
    assert.equal(refused.status, 429);
    assert.equal(await removeUnusedAttachment(upload.path), true);
  } finally {
    await f.close();
  }
});

test('rewinding a conversation releases the uploads its remaining messages no longer show', async () => {
  const f = await fixture();
  try {
    const upload = await saveAttachment(new File([PNG], 'photo.png', { type: 'image/png' }));
    await f.app.request('https://gateway.test/api/conversations/c1/messages', json('POST', {
      text: 'look',
      attachments: [{ path: upload.path, name: 'photo.png', kind: 'image' }],
    }));
    assert.equal(await removeUnusedAttachment(upload.path), false);

    f.agentServer.state.messages = [{ id: 'm1', role: 'user', text: 'look', attachments: [upload] }];
    const rewind = await f.app.request('https://gateway.test/api/conversations/c1/messages/m1', { method: 'DELETE' });
    assert.equal(rewind.status, 200);
    assert.equal((await rewind.json() as { conversation: { id: string } }).conversation.id, 'c1');
    assert.equal(await removeUnusedAttachment(upload.path), true);
  } finally {
    await f.close();
  }
});

test('deleting a conversation releases its uploads', async () => {
  const f = await fixture();
  try {
    const upload = await saveAttachment(new File([PNG], 'photo.png', { type: 'image/png' }));
    await f.app.request('https://gateway.test/api/conversations/c1/messages', json('POST', {
      text: 'look',
      attachments: [{ path: upload.path, name: 'photo.png', kind: 'image' }],
    }));
    const deleted = await f.app.request('https://gateway.test/api/conversations/c1', { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(await removeUnusedAttachment(upload.path), true);
  } finally {
    await f.close();
  }
});

test('MCP settings keep their revision headers and conflicts reach the browser', async () => {
  const f = await fixture();
  try {
    const read = await f.app.request('https://gateway.test/api/mcp');
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('ETag'), '"r1"');
    assert.equal(((await read.json()) as { revision: string }).revision, 'r1');

    const conflict = await f.app.request('https://gateway.test/api/mcp', {
      ...json('PUT', { servers: [] }),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"stale"' },
    });
    assert.equal(conflict.status, 412);
    assert.equal(((await conflict.json()) as { code: string }).code, 'revision_conflict');

    const saved = await f.app.request('https://gateway.test/api/mcp', {
      ...json('PUT', { servers: [] }),
      headers: { 'Content-Type': 'application/json', 'If-Match': '"r1"' },
    });
    assert.equal(saved.status, 200);
    assert.equal(f.agentServer.received.at(-1)!.headers.get('if-match'), '"r1"');
  } finally {
    await f.close();
  }
});

test('the full device list is sent to the agent-server as managed MCP servers', async () => {
  const f = await fixture();
  try {
    const server: McpServer = {
      name: 'device_laptop',
      transport: 'http',
      url: 'http://gateway.test/internal/mcp/devices/laptop',
      managed: { type: 'device', deviceName: 'laptop', connectedAt: '2026-10-22T10:00:00.000Z', tools: 1 },
    };
    await f.agent.setManagedMcp([server]);
    assert.deepEqual(f.agentServer.state.managed, [server]);
    await f.agent.setManagedMcp([]);
    assert.deepEqual(f.agentServer.state.managed, []);
  } finally {
    await f.close();
  }
});

test('voice agent calls need the voice token and reach the agent-server voice endpoints', async () => {
  const f = await fixture();
  try {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    const anonymous = await f.app.request('https://gateway.test/api/voice/conversations/c1/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(anonymous.status, 401);

    const completion = await f.app.request('https://gateway.test/api/voice/conversations/c1/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VOICE_TOKEN}`,
        'X-Voice-Call-Id': 'call-9',
      },
      body,
    });
    assert.equal(completion.status, 200);
    assert.match(completion.headers.get('Content-Type') ?? '', /text\/event-stream/);
    assert.match(await completion.text(), /"call":"call-9"/);
    const forwarded = f.agentServer.received.at(-1)!;
    assert.equal(forwarded.path, '/v1/voice/conversations/c1/chat/completions');
    assert.equal(forwarded.body, body);

    const state = await f.app.request('https://gateway.test/api/voice/conversations/c1/call/state', {
      headers: { Authorization: `Bearer ${VOICE_TOKEN}` },
    });
    assert.deepEqual(await state.json(), { mode: 'short', next: 'end' });
  } finally {
    await f.close();
  }
});

test('an unreachable agent-server is reported as unavailable', async () => {
  const app = new Hono();
  app.route('/api/conversations', createConversationRoutes(new AgentServerClient({ url: 'http://127.0.0.1:9', token: AGENT_TOKEN })));
  const response = await app.request('https://gateway.test/api/conversations');
  assert.equal(response.status, 503);
  assert.match(((await response.json()) as { error: string }).error, /could not be completed/);
});
