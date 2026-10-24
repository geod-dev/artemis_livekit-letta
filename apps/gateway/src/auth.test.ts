import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth } from './auth';

const VOICE_TOKEN = 'test-voice-token';
const PASSWORD = 'test-password';
const ORIGIN = 'https://example.com';

function fixture() {
  const app = createAuth(PASSWORD, 'test-device-token', VOICE_TOKEN);
  app.all('/api/*', (c) => c.json({ private: true }));
  return app;
}

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
const attempt = (
  app: ReturnType<typeof fixture>,
  address: string,
  password = PASSWORD,
  realIp?: string
) =>
  app.request(
    `${ORIGIN}/api/auth/login`,
    login(password, realIp ? { 'X-Real-IP': realIp } : {}),
    peer(address)
  );

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
  assert.throws(() => createAuth('', '', ''), /ARTEMIS_PASSWORD/);
});

test('the voice agent reaches its own endpoints with the voice token only', async () => {
  const app = fixture();
  const call = `${ORIGIN}/api/voice/conversations/c1/call`;
  assert.equal(
    (await app.request(call, { headers: { Authorization: `Bearer ${VOICE_TOKEN}` } })).status,
    200
  );
  assert.equal(
    (await app.request(call, { headers: { Authorization: 'Bearer test-device-token' } })).status,
    401
  );
  assert.equal(
    (await app.request(call, { headers: { Authorization: `Basic ${VOICE_TOKEN}` } })).status,
    401
  );
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
      await createAuth('rotated', '', '').request(`${ORIGIN}/api/conversations`, {
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
  const cookie = (await app.request(`${ORIGIN}/api/auth/login`, login())).headers
    .get('Set-Cookie')!
    .split(';')[0]!;
  const headers = { Cookie: cookie };
  assert.equal((await app.request(`${ORIGIN}/api/auth/session`, { headers })).status, 200);
  assert.equal(
    (await app.request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers })).status,
    200
  );
  assert.equal((await app.request(`${ORIGIN}/api/conversations`, { headers })).status, 401);
  const session = await app.request(`${ORIGIN}/api/auth/session`, { headers });
  assert.deepEqual(await session.json(), { authenticated: false });
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
  const headers = { Authorization: 'Bearer test-device-token' };
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
  const app = createAuth(PASSWORD, 'test-device-token', VOICE_TOKEN);
  app.get('/api/relayed', () => new Response('relayed', { status: 200 }));
  app.get('/api/own-policy', (c) =>
    c.text('kept', 200, { 'Cache-Control': 'private, max-age=60' })
  );
  const cookie = (await app.request(`${ORIGIN}/api/auth/login`, login())).headers
    .get('Set-Cookie')!
    .split(';')[0]!;
  const headers = { Cookie: cookie };
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
