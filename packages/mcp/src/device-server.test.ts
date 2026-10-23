import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type DeviceBinding, handleDeviceMcpRequest, parseDeviceTools } from './device-server.ts';

const device: DeviceBinding = {
  serverName: 'device_test',
  tools: () =>
    parseDeviceTools([{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }]),
  call: async (tool, args) => ({
    content: [{ type: 'text', text: `${tool}:${JSON.stringify(args)}` }],
  }),
};

test('a device answers list and call over standard Streamable HTTP', async () => {
  const fetch = (url: string | URL, init?: RequestInit) =>
    handleDeviceMcpRequest(new Request(url, init), device);
  const transport = new StreamableHTTPClientTransport(new URL('http://device.test/mcp'), { fetch });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ['ping']
    );
    const result = await client.callTool({ name: 'ping', arguments: { a: 1 } });
    assert.deepEqual(result.content, [{ type: 'text', text: 'ping:{"a":1}' }]);
  } finally {
    await client.close();
  }
});

test('more than 100 device tools are rejected', () => {
  const tools = Array.from({ length: 101 }, (_, index) => ({
    name: `t${index}`,
    inputSchema: { type: 'object' },
  }));
  assert.throws(() => parseDeviceTools(tools));
});
