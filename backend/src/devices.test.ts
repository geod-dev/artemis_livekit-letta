import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createDeviceMcpRoutes } from './device-mcp';
import { DeviceHub, createDeviceRoutes } from './devices';
import { McpCatalog } from './mcp-bridge/catalog';
import { mcpClient } from './mcp-bridge/client';
import { bridgeHandlers } from './mcp-bridge/tools';
import { McpRegistry } from './mcp/registry';
import type { McpIo } from './mcp/service';

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
  const files = new Map<string, string>();
  const io: McpIo = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, data) => {
      files.set(path, data);
    },
    enableSkill: async () => {},
    disableSkill: async () => {},
  };
  const catalog = new McpCatalog({ servers: () => registry.list(), client: mcpClient });
  const registry = new McpRegistry(
    io,
    () => hub.servers(),
    async () => {
      await catalog.refresh();
    }
  );
  hub.onChange(() => registry.reconcile());
  return {
    hub,
    registry,
    catalog,
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

test('each device is persisted as a standard MCP server and uses the normal MCP client', async () => {
  const f = await fixture();
  try {
    const session = await f.hub.register('laptop', tools);
    const stored = await f.registry.list();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].managed?.deviceName, 'laptop');
    assert.match(stored[0].url!, /\/internal\/mcp\/devices\/laptop$/);
    assert.equal((await mcpClient.listTools(stored[0]))[0].name, 'open_url');
    const handlers = bridgeHandlers(f.catalog, mcpClient);
    assert.match(
      (await handlers.get('mcp_search')!({ query: 'Firefox' })).text,
      /mcp__device_laptop__open_url/
    );
    assert.equal(
      (await handlers.get('mcp_call')!({ tool: 'mcp__device_laptop__open_url' })).isError,
      true
    );
    const call = handlers.get('mcp_call_write')!({
      tool: 'mcp__device_laptop__open_url',
      arguments: { url: 'https://example.com' },
    });
    const requests = await f.hub.poll('laptop', session, new AbortController().signal);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].params.arguments, { url: 'https://example.com' });
    assert.throws(() => f.hub.result('laptop', 'wrong', requests[0].id, {}), /expired/);
    f.hub.result('laptop', session, requests[0].id, {
      content: [{ type: 'text', text: 'Opened' }],
    });
    assert.deepEqual(await call, { text: 'Opened', isError: false });
    await f.hub.unregister('laptop', session);
    assert.deepEqual(await f.registry.list(), []);
    assert.deepEqual(await f.catalog.current(), []);
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
    for (let attempt = 0; attempt < 50 && (await f.registry.list()).length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(await f.registry.list(), []);
  } finally {
    await f.close();
  }
});

test('devices with the same tool name have independent MCP endpoints and lifetimes', async () => {
  const f = await fixture();
  try {
    const laptop = await f.hub.register('laptop', tools);
    await f.hub.register('desktop', tools);
    const stored = await f.registry.list();
    assert.equal(stored.length, 2);
    assert.notEqual(stored[0].url, stored[1].url);
    assert.notEqual(stored[0].headers?.Authorization, stored[1].headers?.Authorization);
    assert.deepEqual(
      (await f.catalog.current()).map((tool) => tool.qualified),
      ['mcp__device_laptop__open_url', 'mcp__device_desktop__open_url']
    );
    await f.hub.unregister('laptop', laptop);
    assert.deepEqual(
      (await f.registry.list()).map((server) => server.name),
      ['device_desktop']
    );
    assert.equal((await mcpClient.listTools((await f.registry.list())[0]))[0].name, 'open_url');
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
    await f.hub.unregister('laptop', session);
    assert.equal((await f.registry.list()).length, 1);
    assert.equal((await fetch(oldServer.url!, { headers: oldServer.headers })).status, 401);
    await assert.rejects(f.hub.poll('laptop', session, new AbortController().signal), /expired/);
    f.advance(75_001);
    await f.hub.expire();
    assert.deepEqual(await f.registry.list(), []);
    await assert.rejects(f.hub.register('../bad', tools));
  } finally {
    await f.close();
  }
});
