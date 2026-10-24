import type { McpServer } from '@artemis/contracts/chat-types';
import type { WorkspaceTransport } from '@artemis/workspace';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { HttpError } from '../http';
import { createDeviceRoutes } from './api';
import { DeviceHub } from './hub';
import { createDeviceMcpRoutes } from './mcp-endpoint';

const tools = [
  {
    name: 'open_url',
    description: 'Open URL in Firefox',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  },
];
async function fixture() {
  let baseUrl = '',
    now = Date.now();
  const hub = new DeviceHub({ baseUrl: () => baseUrl, now: () => now });
  // The file routes are not reached by these tests, so the workspace is not used.
  const workspace = {} as unknown as WorkspaceTransport;
  const app = new Hono();
  app.route('/internal/mcp/devices', createDeviceMcpRoutes(hub));
  app.route('/api/devices', createDeviceRoutes(hub, workspace));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    hub,
    baseUrl,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      hub.close();
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The reply to one JSON-RPC request (the parts this test reads). */
interface RpcReply {
  result?: {
    serverInfo?: { name: string };
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
}

/** One JSON-RPC request to a device's MCP endpoint, sent as any MCP client sends it. */
async function mcpRequest(server: McpServer, method: string, params: unknown): Promise<RpcReply> {
  const response = await fetch(server.url!, {
    method: 'POST',
    headers: {
      ...server.headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as RpcReply;
}

test('each device is exposed as a standard MCP server that the agent-server can call', async () => {
  const f = await fixture();
  try {
    const session = await f.hub.register('laptop', tools);
    const server = f.hub.servers()[0];
    assert.ok(server);
    assert.equal(server.name, 'device_laptop');
    assert.equal(server.managed?.deviceName, 'laptop');
    assert.match(server.url!, /\/internal\/mcp\/devices\/laptop$/);

    const init = await mcpRequest(server, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agent-server-test', version: '1' },
    });
    assert.equal(init.result?.serverInfo?.name, 'device_laptop');
    const listed = await mcpRequest(server, 'tools/list', {});
    assert.equal(listed.result?.tools?.[0]?.name, 'open_url');

    const call = mcpRequest(server, 'tools/call', {
      name: 'open_url',
      arguments: { url: 'https://example.com' },
    });
    const [request] = await f.hub.poll('laptop', session, new AbortController().signal);
    assert.deepEqual(request?.params.arguments, { url: 'https://example.com' });
    assert.throws(() => f.hub.result('laptop', 'wrong', request!.id, {}), /expired/);
    f.hub.result('laptop', session, request!.id, { content: [{ type: 'text', text: 'Opened' }] });
    const reply = await call;
    assert.notEqual(reply.result?.isError, true);
    assert.equal(reply.result?.content?.[0]?.text, 'Opened');

    await f.hub.unregister('laptop', session);
    assert.deepEqual(f.hub.servers(), []);
  } finally {
    await f.close();
  }
});

test('closing the persistent external connection unregisters the device', async () => {
  const f = await fixture();
  try {
    const session = await f.hub.register('laptop', tools);
    const response = await fetch(`${f.baseUrl}/api/devices/laptop/events`, {
      headers: { 'X-Device-Session': session },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/);
    await reader.cancel();
    for (let attempt = 0; attempt < 50 && f.hub.servers().length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(f.hub.servers(), []);
  } finally {
    await f.close();
  }
});

test('devices with the same tool name have independent MCP endpoints and lifetimes', async () => {
  const f = await fixture();
  try {
    const laptop = await f.hub.register('laptop', tools);
    await f.hub.register('desktop', tools);
    const stored = f.hub.servers();
    assert.deepEqual(
      stored.map((server) => server.name),
      ['device_laptop', 'device_desktop']
    );
    const [laptopServer, desktopServer] = stored;
    assert.notEqual(laptopServer?.url, desktopServer?.url);
    assert.notEqual(laptopServer?.headers?.Authorization, desktopServer?.headers?.Authorization);
    await f.hub.unregister('laptop', laptop);
    assert.deepEqual(
      f.hub.servers().map((server) => server.name),
      ['device_desktop']
    );
  } finally {
    await f.close();
  }
});

test('a connected device keeps its name, and a lapsed name can be registered again', async () => {
  const f = await fixture();
  try {
    const session = await f.hub.register('laptop', tools);
    const oldServer = f.hub.servers()[0]!;
    assert.equal((await fetch(oldServer.url!)).status, 401);
    const call = f.hub.call('laptop', session, 'open_url', {});
    const [request] = await f.hub.poll('laptop', session, new AbortController().signal);
    // A second registration of a live name is refused, and the connected device is not evicted.
    await assert.rejects(
      f.hub.register('laptop', tools),
      (error) => error instanceof HttpError && error.status === 409
    );
    assert.equal(f.hub.servers().length, 1);
    assert.equal(f.hub.tools('laptop', session).length, 1);
    f.hub.result('laptop', session, request!.id, { content: [{ type: 'text', text: 'Opened' }] });
    assert.notEqual((await call).isError, true);

    // Once the lease lapses, the name can be registered again and the old session is dead.
    f.advance(75_001);
    await f.hub.expire();
    const replacement = await f.hub.register('laptop', tools);
    assert.notEqual(replacement, session);
    await assert.rejects(f.hub.poll('laptop', session, new AbortController().signal), /expired/);
    await f.hub.unregister('laptop', session);
    assert.equal(f.hub.servers().length, 1);
    f.advance(75_001);
    await f.hub.expire();
    assert.deepEqual(f.hub.servers(), []);
    assert.throws(() => f.hub.tools('laptop', replacement), /expired/);
    await assert.rejects(f.hub.register('../bad', tools));
  } finally {
    await f.close();
  }
});

test('requests queued before an aborted poll are delivered by the next poll', async () => {
  const hub = new DeviceHub({ baseUrl: () => 'http://gateway.test' });
  try {
    const session = await hub.register('laptop', tools);
    const pending = hub.call('laptop', session, 'open_url', { url: 'https://example.com' });
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await hub.poll('laptop', session, aborted.signal), []);
    const [request] = await hub.poll('laptop', session, new AbortController().signal);
    assert.deepEqual(request?.params.arguments, { url: 'https://example.com' });
    hub.result('laptop', session, request!.id, { content: [{ type: 'text', text: 'Opened' }] });
    assert.notEqual((await pending).isError, true);
  } finally {
    hub.close();
  }
});

test('device connections and disconnections are published to the gateway listener', async () => {
  const hub = new DeviceHub({ baseUrl: () => 'http://gateway.test' });
  const published: string[][] = [];
  hub.onChange(async () => {
    published.push(hub.servers().map((server) => server.name));
  });
  try {
    const session = await hub.register('laptop', tools);
    for (let attempt = 0; attempt < 50 && published.length === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(published, [['device_laptop']]);
    await hub.unregister('laptop', session);
    assert.deepEqual(published.at(-1), []);
  } finally {
    hub.close();
  }
});

test('per-device request queues reject excess work and stay bounded', async () => {
  const hub = new DeviceHub({ baseUrl: () => 'http://gateway.test' });
  try {
    const session = await hub.register('laptop', tools);
    const calls = Array.from({ length: 32 }, () => hub.call('laptop', session, 'open_url', {}));
    await assert.rejects(hub.call('laptop', session, 'open_url', {}), /queue is full/);
    assert.equal((await hub.poll('laptop', session, new AbortController().signal)).length, 32);
    hub.close();
    await Promise.all(calls);
  } finally {
    hub.close();
  }
});
