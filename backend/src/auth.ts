import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isVoiceAgent } from './http';

const COOKIE = 'artemis_session';
const TTL = 90 * 24 * 60 * 60;
export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAuth(password: string, deviceToken: string) {
  if (!password) throw new Error('Set ARTEMIS_PASSWORD in .env before starting the backend');
  const sign = (value: string) =>
    createHmac('sha256', password).update(`artemis-session:${value}`).digest('base64url');
  const valid = (token: string) => {
    const [expires, nonce, signature, extra] = token.split('.');
    return (
      !extra &&
      Boolean(nonce && signature) &&
      Number(expires) > Date.now() / 1000 &&
      equalSecret(signature, sign(`${expires}.${nonce}`))
    );
  };
  const app = new Hono();
  // Global, bounded limiter: cannot be bypassed by forging a proxy IP header.
  let failures = 0,
    resetAt = 0;
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const path = c.req.path;
    const internal = path.startsWith('/api/voice/conversations/') && isVoiceAgent(c.req.raw);
    const device =
      path.startsWith('/api/devices/') &&
      deviceToken &&
      equalSecret(c.req.header('Authorization') ?? '', `Bearer ${deviceToken}`);
    if (internal || device) return next();
    // Cookie requests must come from this origin; bearer clients have no browser cookies.
    const origin = c.req.header('Origin');
    if (
      origin &&
      origin !== new URL(c.req.url).origin &&
      origin !==
        `${c.req.header('X-Forwarded-Proto') === 'https' ? 'https' : 'http'}://${c.req.header('Host')}`
    ) {
      return c.json({ error: 'Invalid origin' }, 403);
    }
    if (path.startsWith('/api/devices/')) return c.json({ error: 'Unauthorized' }, 401);
    if (path === '/api/auth/login' || path === '/api/auth/session') return next();
    if (!valid(getCookie(c, COOKIE) ?? '')) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });
  app.get('/api/auth/session', (c) => c.json({ authenticated: valid(getCookie(c, COOKIE) ?? '') }));
  const cookieOptions = (c: {
    req: { url: string; header: (name: string) => string | undefined };
  }) => ({
    httpOnly: true,
    sameSite: 'Strict' as const,
    path: '/api',
    secure:
      new URL(c.req.url).protocol === 'https:' || c.req.header('X-Forwarded-Proto') === 'https',
  });
  app.post('/api/auth/login', bodyLimit({ maxSize: 4096 }), async (c) => {
    if (Date.now() >= resetAt) {
      failures = 0;
      resetAt = Date.now() + 60_000;
    }
    if (failures >= 10) {
      c.header('Retry-After', '60');
      return c.json({ error: 'Trop de tentatives. Réessayez dans une minute.' }, 429);
    }
    const body = await c.req.json().catch(() => null);
    if (typeof body?.password !== 'string' || !equalSecret(body.password, password)) {
      failures++;
      return c.json({ error: 'Mot de passe incorrect.' }, 401);
    }
    const value = `${Math.floor(Date.now() / 1000) + TTL}.${randomBytes(24).toString('base64url')}`;
    setCookie(c, COOKIE, `${value}.${sign(value)}`, { ...cookieOptions(c), maxAge: TTL });
    return c.json({ authenticated: true });
  });
  app.post('/api/auth/logout', (c) => {
    setCookie(c, COOKIE, '', { ...cookieOptions(c), maxAge: 0 });
    return c.json({ authenticated: false });
  });
  return app;
}
