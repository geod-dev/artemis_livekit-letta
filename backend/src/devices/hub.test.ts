import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createDeviceMcpRoutes } from './mcp';
import { DeviceHub } from './hub';
import { createDeviceRoutes } from './api';

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
  const app = new Hono();
  app.route('/internal/mcp/devices', createDeviceMcpRoutes(hub));
  app.route('/api/devices', createDeviceRoutes(hub));
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

test('each device is exposed as a standard MCP server that the agent-server can call', async () => {
  const f = await fixture();
  let client: Client | undefined;
  try {
    const session = await f.hub.register('laptop', tools);
    const [server] = f.hub.servers();
    assert.equal(server.name, 'device_laptop');
    assert.equal(server.managed?.deviceName, 'laptop');
    assert.match(server.url!, /\/internal\/mcp\/devices\/laptop$/);

    client = new Client({ name: 'agent-server-test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url!), {
        requestInit: { headers: server.headers },
      })
    );
    assert.equal((await client.listTools()).tools[0].name, 'open_url');

    const call = client.callTool({ name: 'open_url', arguments: { url: 'https://example.com' } });
    const [request] = await f.hub.poll('laptop', session, new AbortController().signal);
    assert.deepEqual(request.params.arguments, { url: 'https://example.com' });
    assert.throws(() => f.hub.result('laptop', 'wrong', request.id, {}), /expired/);
    f.hub.result('laptop', session, request.id, { content: [{ type: 'text', text: 'Opened' }] });
    const result = (await call) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].text, 'Opened');

    await f.hub.unregister('laptop', session);
    assert.deepEqual(f.hub.servers(), []);
  } finally {
    await client?.close();
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
    assert.deepEqual(stored.map((server) => server.name), ['device_laptop', 'device_desktop']);
    assert.notEqual(stored[0].url, stored[1].url);
    assert.notEqual(stored[0].headers?.Authorization, stored[1].headers?.Authorization);
    await f.hub.unregister('laptop', laptop);
    assert.deepEqual(f.hub.servers().map((server) => server.name), ['device_desktop']);
  } finally {
    await f.close();
  }
});

test('replacement, missed heartbeat and internal endpoint authentication are scoped per device', async () => {
  const f = await fixture();
  try {
    const session = await f.hub.register('laptop', tools);
    const oldServer = f.hub.servers()[0];
    assert.equal((await fetch(oldServer.url!)).status, 401);
    const call = f.hub.call('laptop', session, 'open_url', {});
    await f.hub.poll('laptop', session, new AbortController().signal);
    const replacement = await f.hub.register('laptop', tools);
    assert.notEqual(replacement, session);
    assert.equal((await call).isError, true);
    // The replaced session can no longer unregister the device, which stays connected.
    await f.hub.unregister('laptop', session);
    assert.equal(f.hub.servers().length, 1);
    assert.equal((await fetch(oldServer.url!, { headers: oldServer.headers })).status, 401);
    await assert.rejects(f.hub.poll('laptop', session, new AbortController().signal), /expired/);
    const current = await f.hub.register('laptop', tools);
    f.advance(75_001);
    await f.hub.expire();
    assert.deepEqual(f.hub.servers(), []);
    assert.throws(() => f.hub.tools('laptop', current), /expired/);
    await assert.rejects(f.hub.register('../bad', tools));
  } finally {
    await f.close();
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
  const hub = new DeviceHub();
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
