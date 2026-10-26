import { getConnInfo } from '@hono/node-server/conninfo';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createGatewayApp } from './app.ts';
import { composeGateway } from './compose.ts';
import { validateConfig } from './config.ts';

const PASSWORD = 'app-test-password';
const ORIGIN = 'https://example.com';
const root = mkdtempSync(join(tmpdir(), 'gateway-app-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** The gateway as server.ts builds it, with TRUSTED_PROXIES as given (undefined: unset). */
function gatewayWith(trustedProxies?: string) {
  const dir = mkdtempSync(join(root, 'gateway-'));
  const config = validateConfig({
    ARTEMIS_PASSWORD: PASSWORD,
    AGENT_SERVER_URL: 'http://127.0.0.1:9',
    AGENT_SERVER_TOKEN: 'app-test-agent-token',
    WORKSPACE_PATH: join(dir, 'workspace'),
    ARTEMIS_DATA_DIR: join(dir, 'data'),
    ...(trustedProxies === undefined ? {} : { TRUSTED_PROXIES: trustedProxies }),
  });
  return createGatewayApp(composeGateway(config), {
    peerAddress: (c) => getConnInfo(c).remote.address,
  });
}

type Gateway = ReturnType<typeof gatewayWith>;

/** One login attempt from a socket address, optionally with the nginx X-Real-IP header. */
const attempt = (app: Gateway, address: string, password = PASSWORD, realIp?: string) =>
  app.request(
    `${ORIGIN}/api/auth/login`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(realIp ? { 'X-Real-IP': realIp } : {}),
      },
      body: JSON.stringify({ password }),
    },
    { incoming: { socket: { remoteAddress: address, remoteFamily: 'IPv4' } } }
  );

test('TRUSTED_PROXIES reaches the auth layer: a spoofed X-Real-IP from loopback is ignored', async () => {
  const app = gatewayWith('172.29.250.10');
  // 127.0.0.1 is not a configured proxy, so its X-Real-IP is ignored even though loopback is private.
  for (let i = 0; i < 10; i++)
    assert.equal((await attempt(app, '127.0.0.1', 'wrong', `10.1.0.${i}`)).status, 401);
  assert.equal((await attempt(app, '127.0.0.1', PASSWORD, '10.1.0.99')).status, 429);
  // The configured web proxy's X-Real-IP is honoured: the forwarded client is the one counted.
  for (let i = 0; i < 10; i++)
    assert.equal((await attempt(app, '172.29.250.10', 'wrong', '10.2.0.1')).status, 401);
  assert.equal((await attempt(app, '172.29.250.10', PASSWORD, '10.2.0.1')).status, 429);
  assert.equal((await attempt(app, '172.29.250.10', PASSWORD, '10.2.0.2')).status, 200);
});

test('unset TRUSTED_PROXIES keeps the default: a loopback peer X-Real-IP is honoured', async () => {
  const app = gatewayWith(undefined);
  for (let i = 0; i < 10; i++)
    assert.equal((await attempt(app, '127.0.0.1', 'wrong', `10.3.0.${i}`)).status, 401);
  // A fresh forwarded address is a new window, so the login is accepted.
  assert.equal((await attempt(app, '127.0.0.1', PASSWORD, '10.3.0.99')).status, 200);
});
