import { getConnInfo } from '@hono/node-server/conninfo';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createSessionAuth } from './auth.ts';

const DEVICE_TOKEN = 'test-device-token';
const PASSWORD = 'test-password';
const ORIGIN = 'https://example.com';
const root = mkdtempSync(join(tmpdir(), 'gateway-auth-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A session gate over a data directory, with the Node socket lookup the server uses. */
function gate(dataDir = mkdtempSync(join(root, 'data-')), password = PASSWORD) {
  return createSessionAuth({
    password,
    deviceToken: DEVICE_TOKEN,
    dataDir,
    peerAddress: (c) => getConnInfo(c).remote.address,
  });
}

/** The gate with a catch-all private API behind it, for the routes that need one. */
function fixture(dataDir?: string, password = PASSWORD) {
  const app = gate(dataDir, password);
  app.all('/api/*', (c) => c.json({ private: true }));
  return app;
}

type App = ReturnType<typeof fixture>;

/** The socket address Node reports for a request, passed to app.request as the environment. */
const peer = (address: string) => ({
  incoming: {
    socket: { remoteAddress: address, remoteFamily: address.includes(':') ? 'IPv6' : 'IPv4' },
  },
});

const login = (password = PASSWORD, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ password }),
});

/** One login attempt from a socket address, optionally with the nginx X-Real-IP header. */
const attempt = (app: App, address: string, password = PASSWORD, realIp?: string) =>
  app.request(
    `${ORIGIN}/api/auth/login`,
    login(password, realIp ? { 'X-Real-IP': realIp } : {}),
    peer(address)
  );

/** The session cookie of a successful login, as the Cookie header a browser sends back. */
async function sessionCookie(app: App): Promise<string> {
  const response = await app.request(`${ORIGIN}/api/auth/login`, login());
  return response.headers.get('Set-Cookie')!.split(';')[0]!;
}

test('all personal APIs, files, event streams and voice tokens require a session', async () => {
  const app = fixture();
  for (const path of [
    '/conversations',
    '/conversations/id/events',
    '/workspace/file',
    '/attachments',
    '/mcp',
    '/voice/token',
    '/devices/register',
  ]) {
    assert.equal((await app.request(ORIGIN + '/api' + path)).status, 401, path);
  }
  assert.throws(
    () => createSessionAuth({ password: '', deviceToken: '', dataDir: root }),
    /ARTEMIS_PASSWORD/
  );
});

test('the voice agent endpoints pass the session gate; the device token does not open other routes', async () => {
  // The voice router checks its own bearer token (see routes/voice.test.ts); the gate lets the
  // voice agent's paths through without a cookie, and nothing else.
  const app = fixture();
  const call = `${ORIGIN}/api/voice/conversations/c1/call`;
  assert.equal((await app.request(call)).status, 200);
  assert.equal(
    (await app.request(call, { headers: { Authorization: `Bearer ${DEVICE_TOKEN}` } })).status,
    200
  );
  assert.equal((await app.request(`${ORIGIN}/api/voice/token`)).status, 401);
});

test('login cookie is protected, survives requests, rejects forgery and password rotation', async () => {
  const app = fixture();
  assert.equal((await app.request(`${ORIGIN}/api/auth/login`, login('wrong'))).status, 401);
  const response = await app.request(`${ORIGIN}/api/auth/login`, login());
  const cookie = response.headers.get('Set-Cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  const headers = { Cookie: cookie.split(';')[0] };
  assert.equal((await app.request(`${ORIGIN}/api/conversations`, { headers })).status, 200);
  assert.equal(
    (
      await app.request(`${ORIGIN}/api/conversations`, {
        headers: { Cookie: headers.Cookie + 'x' },
      })
    ).status,
    401
  );
  assert.equal(
    (
      await fixture(undefined, 'rotated').request(`${ORIGIN}/api/conversations`, {
        headers,
      })
    ).status,
    401
  );
  const logout = await app.request(`${ORIGIN}/api/auth/logout`, {
    method: 'POST',
    headers,
  });
  assert.match(logout.headers.get('Set-Cookie')!, /Max-Age=0/);
});

test('a logged-out session token is revoked, even though its signature is still valid', async () => {
  const app = fixture();
  const headers = { Cookie: await sessionCookie(app) };
  assert.equal((await app.request(`${ORIGIN}/api/auth/session`, { headers })).status, 200);
  assert.equal(
    (await app.request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers })).status,
    200
  );
  assert.equal((await app.request(`${ORIGIN}/api/conversations`, { headers })).status, 401);
  const session = await app.request(`${ORIGIN}/api/auth/session`, { headers });
  assert.deepEqual(await session.json(), { authenticated: false });
});

test('a logged-out session stays revoked after the gateway restarts from the same data directory', async () => {
  const dataDir = mkdtempSync(join(root, 'restart-'));
  const before = fixture(dataDir);
  const headers = { Cookie: await sessionCookie(before) };
  assert.equal(
    (await before.request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers })).status,
    200
  );
  assert.ok(existsSync(join(dataDir, 'auth', 'revoked.json')));
  const after = fixture(dataDir);
  assert.equal((await after.request(`${ORIGIN}/api/conversations`, { headers })).status, 401);
});

test('CSRF and brute force rejected; device credentials cannot access chats', async () => {
  const app = fixture();
  assert.equal(
    (
      await app.request(`${ORIGIN}/api/auth/login`, {
        ...login(),
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      })
    ).status,
    403
  );
  const headers = { Authorization: `Bearer ${DEVICE_TOKEN}` };
  assert.equal((await app.request(`${ORIGIN}/api/devices/register`, { headers })).status, 200);
  assert.equal((await app.request(`${ORIGIN}/api/conversations`, { headers })).status, 401);
  for (let i = 0; i < 10; i++)
    assert.equal((await app.request(`${ORIGIN}/api/auth/login`, login('wrong'))).status, 401);
  assert.equal((await app.request(`${ORIGIN}/api/auth/login`, login())).status, 429);
});

test('login failures are limited per client, and X-Real-IP is read only from a proxy', async () => {
  const app = fixture();
  // Through nginx (a loopback peer), the forwarded client address is the one counted.
  for (let i = 0; i < 10; i++)
    assert.equal((await attempt(app, '127.0.0.1', 'wrong', '10.0.0.1')).status, 401);
  assert.equal((await attempt(app, '127.0.0.1', PASSWORD, '10.0.0.1')).status, 429);
  assert.equal((await attempt(app, '127.0.0.1', PASSWORD, '10.0.0.2')).status, 200);
  // Directly from a public address, a client cannot pick its own window with X-Real-IP.
  for (let i = 0; i < 10; i++)
    assert.equal((await attempt(app, '203.0.113.9', 'wrong', `10.9.0.${i}`)).status, 401);
  assert.equal((await attempt(app, '203.0.113.9', PASSWORD, '10.0.0.3')).status, 429);
});

test('a blocked client is told how long its window has left, and the refusal is in English', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const app = fixture();
  for (let i = 0; i < 10; i++)
    assert.equal((await attempt(app, '203.0.113.40', 'wrong')).status, 401);
  const refused = await attempt(app, '203.0.113.40');
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('Retry-After'), '60');
  assert.deepEqual(await refused.json(), { error: 'Too many attempts. Try again later.' });
  t.mock.timers.tick(30_000);
  assert.equal((await attempt(app, '203.0.113.40')).headers.get('Retry-After'), '30');
  const wrong = await attempt(app, '203.0.113.41', 'wrong');
  assert.deepEqual(await wrong.json(), { error: 'Incorrect password.' });
});

test('the global ceiling reached across clients refuses logins', async () => {
  const app = fixture();
  // Ten failures from one proxied client, then forty from others: fifty in all.
  for (let i = 0; i < 10; i++)
    assert.equal((await attempt(app, '127.0.0.1', 'wrong', '10.0.0.1')).status, 401);
  assert.equal((await attempt(app, '127.0.0.1', PASSWORD, '10.0.0.2')).status, 200);
  for (let i = 0; i < 40; i++)
    assert.equal((await attempt(app, '127.0.0.1', 'wrong', `10.1.0.${i}`)).status, 401);
  assert.equal((await attempt(app, '127.0.0.1', PASSWORD, '10.2.0.1')).status, 429);
});

test('the global lockout doubles on each repeat and then reopens', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const app = fixture();
  const fails = async (from: number) => {
    for (let i = 0; i < 50; i++)
      assert.equal((await attempt(app, `203.0.113.${from + i}`, 'wrong')).status, 401);
  };
  await fails(1);
  const locked = await attempt(app, '198.51.100.1');
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('Retry-After'), '60');

  t.mock.timers.tick(60_000);
  await fails(51);
  // The second lockout is 120 s long, so a correct password is still refused at 119 s.
  t.mock.timers.tick(119_000);
  assert.equal((await attempt(app, '198.51.100.2')).status, 429);
  t.mock.timers.tick(1_000);
  assert.equal((await attempt(app, '198.51.100.3')).status, 200);
});

test('an /api response with no cache policy is no-store, raw Responses included', async () => {
  const app = gate();
  app.get('/api/relayed', () => new Response('relayed', { status: 200 }));
  app.get('/api/own-policy', (c) =>
    c.text('kept', 200, { 'Cache-Control': 'private, max-age=60' })
  );
  const headers = { Cookie: await sessionCookie(app) };
  for (const path of ['/api/relayed', '/api/auth/session']) {
    const response = await app.request(`${ORIGIN}${path}`, { headers });
    assert.equal(response.headers.get('Cache-Control'), 'no-store', path);
  }
  assert.equal(
    (await app.request(`${ORIGIN}/api/own-policy`, { headers })).headers.get('Cache-Control'),
    'private, max-age=60'
  );
  const refused = await app.request(`${ORIGIN}/api/relayed`);
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('Cache-Control'), 'no-store');
});
