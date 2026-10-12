import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeviceHub } from './devices';
import { McpCatalog } from './mcp-bridge/catalog';
import { bridgeHandlers } from './mcp-bridge/tools';

const tools = [
  {
    name: 'open_url',
    description: 'Open URL in Firefox',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
  },
];
test('device tools are discoverable and execute through the existing MCP bridge', async () => {
  const hub = new DeviceHub();
  const session = hub.register('laptop', tools);
  const client = { listTools: async () => [], callTool: hub.call.bind(hub) };
  const catalog = new McpCatalog({
    servers: async () => [],
    client,
    extraTools: () => hub.catalog(),
  });
  const handlers = bridgeHandlers(catalog, client);
  const search = await handlers.get('mcp_search')!({ query: 'Firefox' });
  assert.match(search.text, /mcp__device_laptop__open_url/);
  const refused = await handlers.get('mcp_call')!({
    tool: 'mcp__device_laptop__open_url',
    arguments: {},
  });
  assert.equal(refused.isError, true);
  const call = handlers.get('mcp_call_write')!({
    tool: 'mcp__device_laptop__open_url',
    arguments: { url: 'https://example.com' },
  });
  // Catalog lookup is asynchronous; wait until the call is queued.
  const requests = await hub.poll('laptop', session, new AbortController().signal);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'tools/call');
  assert.deepEqual(requests[0].params.arguments, { url: 'https://example.com' });
  assert.throws(() => hub.result('laptop', 'wrong', requests[0].id, {}), /expired/);
  hub.result('laptop', session, requests[0].id, { content: [{ type: 'text', text: 'Opened' }] });
  assert.deepEqual(await call, { text: 'Opened', isError: false });
});
test('replacement session rejects pending calls and old connections; validates registrations', async () => {
  const hub = new DeviceHub();
  const session = hub.register('laptop', tools);
  const call = hub.call(hub.catalog()[0].server, 'open_url', {});
  const requests = await hub.poll('laptop', session, new AbortController().signal);
  const next = hub.register('laptop', tools);
  assert.notEqual(next, session);
  assert.equal((await call).isError, true);
  assert.throws(() => hub.result('laptop', next, requests[0].id, {}), /expired/);
  await assert.rejects(hub.poll('laptop', session, new AbortController().signal), /expired/);
  assert.throws(() => hub.register('../bad', tools));
  assert.throws(() => hub.register('ok', [{ name: 'bad', inputSchema: { type: 'string' } }]));
});
