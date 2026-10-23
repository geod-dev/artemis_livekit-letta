import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth } from './auth';

const VOICE_TOKEN = 'test-voice-token';

function fixture() {
  const app = createAuth('test-password', 'test-device-token', VOICE_TOKEN);
  app.all('/api/*', (c) => c.json({ private: true }));
  return app;
}
const login = (password = 'test-password', headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ password }),
});
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
    assert.equal((await app.request('https://example.com/api' + path)).status, 401, path);
  }
  assert.throws(() => createAuth('', '', ''), /ARTEMIS_PASSWORD/);
});
test('the voice agent reaches its own endpoints with the voice token only', async () => {
  const app = fixture();
  const call = 'https://example.com/api/voice/conversations/c1/call';
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
  assert.equal(
    (await app.request('https://example.com/api/auth/login', login('wrong'))).status,
    401
  );
  const response = await app.request('https://example.com/api/auth/login', login());
  const cookie = response.headers.get('Set-Cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  const headers = { Cookie: cookie.split(';')[0] };
  assert.equal(
    (await app.request('https://example.com/api/conversations', { headers })).status,
    200
  );
  assert.equal(
    (
      await app.request('https://example.com/api/conversations', {
        headers: { Cookie: headers.Cookie + 'x' },
      })
    ).status,
    401
  );
  assert.equal(
    (
      await createAuth('rotated', '', '').request('https://example.com/api/conversations', {
        headers,
      })
    ).status,
    401
  );
  const logout = await app.request('https://example.com/api/auth/logout', {
    method: 'POST',
    headers,
  });
  assert.match(logout.headers.get('Set-Cookie')!, /Max-Age=0/);
});
test('CSRF and brute force rejected; device credentials cannot access chats', async () => {
  const app = fixture();
  assert.equal(
    (
      await app.request('https://example.com/api/auth/login', {
        ...login(),
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      })
    ).status,
    403
  );
  const headers = { Authorization: 'Bearer test-device-token' };
  assert.equal(
    (await app.request('https://example.com/api/devices/register', { headers })).status,
    200
  );
  assert.equal(
    (await app.request('https://example.com/api/conversations', { headers })).status,
    401
  );
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await app.request('https://example.com/api/auth/login', login('wrong'))).status,
      401
    );
  assert.equal((await app.request('https://example.com/api/auth/login', login())).status, 429);
});
test('login failures are limited per client address, with a global ceiling', async () => {
  const app = fixture();
  const from = (address: string) => ({ 'X-Real-IP': address });
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await app.request('https://example.com/api/auth/login', login('wrong', from('10.0.0.1'))))
        .status,
      401
    );
  assert.equal(
    (
      await app.request(
        'https://example.com/api/auth/login',
        login('test-password', from('10.0.0.1'))
      )
    ).status,
    429
  );
  assert.equal(
    (
      await app.request(
        'https://example.com/api/auth/login',
        login('test-password', from('10.0.0.2'))
      )
    ).status,
    200
  );
  // Forty failures from other clients, each under its own limit, reach the global ceiling of 50.
  for (let i = 0; i < 40; i++)
    assert.equal(
      (await app.request('https://example.com/api/auth/login', login('wrong', from(`10.1.0.${i}`))))
        .status,
      401
    );
  assert.equal(
    (
      await app.request(
        'https://example.com/api/auth/login',
        login('test-password', from('10.2.0.1'))
      )
    ).status,
    429
  );
});
