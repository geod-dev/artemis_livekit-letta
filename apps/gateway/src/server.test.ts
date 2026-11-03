import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { startGateway } from './server.ts';

const root = mkdtempSync(join(tmpdir(), 'gateway-server-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A loopback port nothing listens on, found by binding and releasing it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

test('startGateway serves until close, then stops listening and releases its signal handlers', async () => {
  const names = [
    'NODE_ENV',
    'GATEWAY_HOST',
    'GATEWAY_PORT',
    'AGENT_SERVER_URL',
    'WORKSPACE_PATH',
    'ARTEMIS_DATA_DIR',
    'ARTEMIS_PASSWORD',
    'VOICE_GATEWAY_TOKEN',
    'ARTEMIS_DEVICE_TOKEN',
  ] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const port = await freePort();
  Object.assign(process.env, {
    NODE_ENV: 'development',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    // Nothing listens here; the device sync's pushes fail quietly while the gateway runs.
    AGENT_SERVER_URL: `http://127.0.0.1:${await freePort()}`,
    WORKSPACE_PATH: join(root, 'workspace'),
    ARTEMIS_DATA_DIR: join(root, 'data'),
    ARTEMIS_PASSWORD: 'test-password',
    VOICE_GATEWAY_TOKEN: 'test-voice-token',
    // Set here so the test does not depend on a local .env, which CI does not have.
    ARTEMIS_DEVICE_TOKEN: 'test-device-token',
  });
  const sigint = process.listenerCount('SIGINT');
  const sigterm = process.listenerCount('SIGTERM');
  try {
    const gateway = await startGateway();
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(process.listenerCount('SIGINT'), sigint + 1);
    assert.equal(process.listenerCount('SIGTERM'), sigterm + 1);

    await gateway.close();
    // Once close resolves the server no longer accepts connections.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    assert.equal(process.listenerCount('SIGINT'), sigint);
    assert.equal(process.listenerCount('SIGTERM'), sigterm);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
