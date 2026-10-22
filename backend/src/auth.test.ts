import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuth } from './auth';

function fixture() {
  const app = createAuth('test-password', 'test-device-token');
  app.all('/api/*', (c) => c.json({ private: true }));
  return app;
}
const login = (password = 'test-password') => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
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
  assert.throws(() => createAuth('', ''), /ARTEMIS_PASSWORD/);
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
    (await createAuth('rotated', '').request('https://example.com/api/conversations', { headers }))
      .status,
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
