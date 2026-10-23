import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { bearerToken, sameSecret } from './http';

const COOKIE = 'artemis_session';
const TTL = 90 * 24 * 60 * 60;
/** Failed logins are counted per window: per client address, and across every client. */
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_LIMIT_PER_CLIENT = 10;
const LOGIN_LIMIT_GLOBAL = 50;
/** Client windows kept in memory; expired windows are dropped when the map is full. */
const MAX_TRACKED_CLIENTS = 10_000;

export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Failed logins in the current window, for one key (a client address, or every client). */
class FailureWindow {
  private failures = 0;
  private resetAt = 0;

  constructor(private readonly limit: number) {}

  /** True while the window has reached its limit; a window that has run out starts again. */
  blocked(now: number): boolean {
    if (this.expired(now)) {
      this.failures = 0;
      this.resetAt = now + LOGIN_WINDOW_MS;
    }
    return this.failures >= this.limit;
  }

  fail(): void {
    this.failures++;
  }

  expired(now: number): boolean {
    return now >= this.resetAt;
  }
}

export function createAuth(password: string, deviceToken: string, voiceToken: string) {
  if (!password) throw new Error('Set ARTEMIS_PASSWORD in .env before starting the gateway');
  // The cookie is signed with a key derived from the password, so the password never signs directly.
  const signingKey = createHmac('sha256', password).update('artemis-session-signing-key').digest();
  const sign = (value: string) =>
    createHmac('sha256', signingKey).update(`artemis-session:${value}`).digest('base64url');
  const valid = (token: string) => {
    const [expires, nonce, signature = '', extra] = token.split('.');
    return (
      !extra &&
      Boolean(nonce && signature) &&
      Number(expires) > Date.now() / 1000 &&
      equalSecret(signature, sign(`${expires}.${nonce}`))
    );
  };
  const app = new Hono();
  // Login failures are limited per client and across all clients. The client address is
  // the X-Real-IP header, which nginx sets from the socket address and overwrites whatever
  // the client sent; the gateway trusts it only behind that proxy. Without the header,
  // every request shares one client window.
  const everyone = new FailureWindow(LOGIN_LIMIT_GLOBAL);
  const clients = new Map<string, FailureWindow>();
  const clientWindow = (key: string): FailureWindow => {
    const known = clients.get(key);
    if (known) return known;
    const window = new FailureWindow(LOGIN_LIMIT_PER_CLIENT);
    if (clients.size >= MAX_TRACKED_CLIENTS) {
      const now = Date.now();
      for (const [id, old] of clients) if (old.expired(now)) clients.delete(id);
    }
    if (clients.size < MAX_TRACKED_CLIENTS) clients.set(key, window);
    return window;
  };
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const path = c.req.path;
    const internal =
      path.startsWith('/api/voice/conversations/') &&
      sameSecret(bearerToken(c.req.raw), voiceToken);
    const device =
      path.startsWith('/api/devices/') && sameSecret(bearerToken(c.req.raw), deviceToken);
    if (internal || device) return next();
    // Cookie requests must come from this origin; bearer clients have no browser cookies.
    // Behind nginx, X-Forwarded-Proto comes from a fixed map and the edge strips any
    // client-supplied forwarding header, so the gateway trusts it only behind that proxy.
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
    const now = Date.now();
    const client = clientWindow(c.req.header('X-Real-IP') ?? 'unknown');
    if (everyone.blocked(now) || client.blocked(now)) {
      c.header('Retry-After', '60');
      return c.json({ error: 'Trop de tentatives. Réessayez dans une minute.' }, 429);
    }
    const body = await c.req.json().catch(() => null);
    if (typeof body?.password !== 'string' || !equalSecret(body.password, password)) {
      everyone.fail();
      client.fail();
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
