import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentServerClient } from '../agent-server/client.ts';
import { createMcpRoutes } from './mcp-settings.ts';

const settings = {
  revision: 'r1',
  servers: [
    {
      name: 'device_laptop',
      transport: 'http',
      url: 'http://gateway.test/internal/mcp/devices/laptop',
      headers: { Authorization: 'Bearer device-secret' },
      managed: { type: 'device', deviceName: 'laptop', connectedAt: 'now', tools: 1 },
    },
    {
      name: 'docs',
      transport: 'http',
      url: 'https://docs.example.test/mcp',
      headers: { 'X-Api-Key': 'user-own-key' },
    },
  ],
  diagnostics: [],
};

/** The routes over a fake agent-server that answers GET with `answer`. */
function routesAnswering(answer: () => Response) {
  const agent = {
    relay: async () => answer(),
  } as unknown as AgentServerClient;
  return createMcpRoutes(agent);
}

test('GET /api/mcp never returns a device server bearer key', async () => {
  const routes = routesAnswering(() => Response.json(settings));
  const response = await routes.fetch(new Request('http://gateway.test/'));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes('Bearer'), 'the device bearer key must not reach the browser');
  assert.ok(!text.includes('device-secret'));
  const body = JSON.parse(text) as { servers: Array<{ name: string; headers?: unknown }> };
  const [device, docs] = body.servers;
  assert.equal(device!.name, 'device_laptop');
  assert.equal(device!.headers, undefined);
  assert.deepEqual(docs!.headers, { 'X-Api-Key': 'user-own-key' });
});

test('PUT /api/mcp never returns a device server bearer key', async () => {
  const routes = routesAnswering(() => Response.json(settings));
  const response = await routes.fetch(
    new Request('http://gateway.test/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: 'r1', servers: [] }),
    })
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes('Bearer'), 'the device bearer key must not reach the browser');
  assert.ok(!text.includes('device-secret'));
  const body = JSON.parse(text) as { servers: Array<{ name: string; headers?: unknown }> };
  assert.equal(body.servers[0]!.headers, undefined);
  assert.deepEqual(body.servers[1]!.headers, { 'X-Api-Key': 'user-own-key' });
});

test('GET /api/mcp refuses a successful answer that is not the settings object', async () => {
  const routes = routesAnswering(() => new Response('not json', { status: 200 }));
  const response = await routes.fetch(new Request('http://gateway.test/'));
  assert.equal(response.status, 502);
});

test('GET /api/mcp passes an upstream error through unchanged', async () => {
  const routes = routesAnswering(() => Response.json({ error: 'bad' }, { status: 422 }));
  const response = await routes.fetch(new Request('http://gateway.test/'));
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: 'bad' });
});
