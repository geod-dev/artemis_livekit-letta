import type { WorkspaceTransport } from '@artemis/workspace';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeDeviceProtocol } from '../compose.ts';
import { createDeviceRoutes } from './api.ts';
import { DeviceHub } from './hub.ts';

const LEASE_MS = 75_000;
const tools = [{ name: 'open_url', inputSchema: { type: 'object' } }];

/** The device routes over the real hub, with a fake clock. The routes never touch the workspace. */
function fixture() {
  let now = Date.now();
  const hub = new DeviceHub({
    baseUrl: () => 'http://gateway.test',
    protocol: composeDeviceProtocol(),
    now: () => now,
  });
  const routes = createDeviceRoutes(hub, {} as unknown as WorkspaceTransport);
  const call = (method: string, path: string, options: { body?: unknown; session?: string } = {}) =>
    routes.fetch(
      new Request(`http://gateway.test${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(options.session ? { 'X-Device-Session': options.session } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    );
  const register = async (name = 'laptop') => {
    const response = await call('POST', '/register', { body: { name, tools } });
    assert.equal(response.status, 200);
    return ((await response.json()) as { session: string }).session;
  };
  return {
    hub,
    call,
    register,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('a name held by a connected device answers 409 and the device is kept', async () => {
  const f = fixture();
  try {
    await f.register();
    const response = await f.call('POST', '/register', { body: { name: 'laptop', tools } });
    assert.equal(response.status, 409);
    assert.match(((await response.json()) as { error: string }).error, /in use/);
    assert.equal(f.hub.servers().length, 1);
  } finally {
    f.hub.close();
  }
});

test('an invalid registration answers 400 with its reason', async () => {
  const f = fixture();
  try {
    const response = await f.call('POST', '/register', {
      body: { name: 'laptop', tools: [{ name: 'bad name', inputSchema: { type: 'object' } }] },
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, 'Invalid MCP tool name');
  } finally {
    f.hub.close();
  }
});

test('an expired session answers 410, and a lapsed name can register again', async () => {
  const f = fixture();
  try {
    const session = await f.register();
    f.advance(LEASE_MS + 1);
    const heartbeat = await f.call('POST', '/laptop/heartbeat', { session });
    assert.equal(heartbeat.status, 410);
    assert.match(((await heartbeat.json()) as { error: string }).error, /register again/);
    const replacement = await f.register();
    assert.notEqual(replacement, session);
  } finally {
    f.hub.close();
  }
});

test('heartbeat renews a live session and disconnect removes the device', async () => {
  const f = fixture();
  try {
    const session = await f.register();
    assert.equal((await f.call('POST', '/laptop/heartbeat', { session })).status, 200);
    const disconnect = await f.call('POST', '/laptop/disconnect', { session });
    assert.equal(disconnect.status, 200);
    assert.deepEqual(f.hub.servers(), []);
  } finally {
    f.hub.close();
  }
});

test('poll delivers a queued call, and a result answers the call', async () => {
  const f = fixture();
  try {
    const session = await f.register();
    const pending = f.hub.call('laptop', session, 'open_url', { url: 'https://example.test' });
    const poll = await f.call('GET', '/laptop/poll', { session });
    assert.equal(poll.status, 200);
    const { requests } = (await poll.json()) as { requests: Array<{ id: string; method: string }> };
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, 'tools/call');
    const result = await f.call('POST', '/laptop/results', {
      session,
      body: { id: requests[0]!.id, result: { content: [{ type: 'text', text: 'Opened' }] } },
    });
    assert.equal(result.status, 200);
    assert.notEqual((await pending).isError, true);
  } finally {
    f.hub.close();
  }
});

test('a result without a matching call answers 409, and a non-object body answers 400', async () => {
  const f = fixture();
  try {
    const session = await f.register();
    const missingId = await f.call('POST', '/laptop/results', {
      session,
      body: { result: { content: [] } },
    });
    assert.equal(missingId.status, 409);
    const notAnObject = await f.call('POST', '/laptop/results', { session, body: 'text' });
    assert.equal(notAnObject.status, 400);
  } finally {
    f.hub.close();
  }
});
