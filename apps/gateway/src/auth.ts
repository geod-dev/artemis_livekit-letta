import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { createHmac, randomBytes } from 'node:crypto';
import { bearerToken } from './http';
import { isLocalOrPrivateAddress, sameSecret } from './security';

const COOKIE = 'artemis_session';
const TTL = 90 * 24 * 60 * 60;
/** Failed logins are counted per window: per client address, and across every client. */
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_LIMIT_PER_CLIENT = 10;
const LOGIN_LIMIT_GLOBAL = 50;
/** The lockout of the global ceiling doubles on each repeat, up to this length. */
const MAX_GLOBAL_LOCKOUT_MS = 15 * 60_000;
/** Client windows kept in memory; expired windows are dropped when the map is full. */
const MAX_TRACKED_CLIENTS = 10_000;

/** Failed logins in the current window, for one client address. */
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

/**
 * The ceiling across all clients. When one window collects the limit of failures,
 * logins are refused for a lockout that doubles on each repeat (60 s, 120 s, ... up to
 * 15 min). A successful login clears the repeats. A full quiet window after the
 * lockout ends clears them too.
 */
class GlobalCeiling {
  private failures = 0;
  private windowEnd = 0;
  private lockedUntil = 0;
  private repeats = 0;

  /** Milliseconds until logins are accepted again; 0 while they are open. */
  lockedFor(now: number): number {
    return Math.max(0, this.lockedUntil - now);
  }

  fail(now: number): void {
    if (now >= this.windowEnd) {
      this.failures = 0;
      this.windowEnd = now + LOGIN_WINDOW_MS;
      if (now >= this.lockedUntil + LOGIN_WINDOW_MS) this.repeats = 0;
    }
    this.failures++;
    if (this.failures < LOGIN_LIMIT_GLOBAL) return;
    this.failures = 0;
    this.repeats++;
    this.lockedUntil =
      now + Math.min(LOGIN_WINDOW_MS * 2 ** (this.repeats - 1), MAX_GLOBAL_LOCKOUT_MS);
  }

  /** A login succeeds only while the ceiling is open, so this resets the repeat count only. */
  succeed(): void {
    this.repeats = 0;
  }
}

/** The socket address of the request, when the app is served by Node (absent in-process). */
function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * The address a login failure is counted against. nginx sets X-Real-IP from the socket
 * and overwrites any value the client sent, so the header is read only when the direct
 * peer is a loopback or private address (the proxy). Otherwise the socket address counts.
 */
function clientAddress(c: Context): string {
  const peer = peerAddress(c);
  const forwarded = c.req.header('X-Real-IP');
  if (forwarded && peer && isLocalOrPrivateAddress(peer)) return forwarded;
  return peer ?? 'unknown';
}

/** Every /api response is uncacheable. Relayed responses have immutable headers, so the header goes on a copy. */
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createAuth(password: string, deviceToken: string, voiceToken: string) {
  if (!password) throw new Error('Set ARTEMIS_PASSWORD in .env before starting the gateway');
  // The cookie is signed with a key derived from the password, so the password never signs directly.
  const signingKey = createHmac('sha256', password).update('artemis-session-signing-key').digest();
  const sign = (value: string) =>
    createHmac('sha256', signingKey).update(`artemis-session:${value}`).digest('base64url');
  // Logged-out sessions, by token nonce, kept until the token itself expires (epoch seconds).
  const revoked = new Map<string, number>();
  const valid = (token: string) => {
    const [expires = '', nonce = '', signature = '', extra] = token.split('.');
    return (
      !extra &&
      Boolean(nonce && signature) &&
      Number(expires) > Date.now() / 1000 &&
      sameSecret(signature, sign(`${expires}.${nonce}`)) &&
      !revoked.has(nonce)
    );
  };
  const revoke = (token: string) => {
    const [expires = '', nonce = ''] = token.split('.');
    const now = Date.now() / 1000;
    for (const [id, until] of revoked) if (until <= now) revoked.delete(id);
    revoked.set(nonce, Number(expires));
  };
  const app = new Hono();
  // Registered first, so it also sees the responses the authentication below returns early.
  // A response that names no cache policy of its own (a JSON body, or a relayed one without
  // Cache-Control) is uncacheable; a route or the agent-server that sets one keeps it.
  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.res = withNoStore(c.res);
  });
  // Login failures are limited per client and across all clients (see clientAddress).
  const everyone = new GlobalCeiling();
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
    const client = clientWindow(clientAddress(c));
    const globalWait = everyone.lockedFor(now);
    if (globalWait > 0 || client.blocked(now)) {
      c.header('Retry-After', String(globalWait > 0 ? Math.ceil(globalWait / 1000) : 60));
      return c.json({ error: 'Trop de tentatives. Réessayez plus tard.' }, 429);
    }
    const body = await c.req.json().catch(() => null);
    if (typeof body?.password !== 'string' || !sameSecret(body.password, password)) {
      everyone.fail(now);
      client.fail();
      return c.json({ error: 'Mot de passe incorrect.' }, 401);
    }
    everyone.succeed();
    const value = `${Math.floor(Date.now() / 1000) + TTL}.${randomBytes(24).toString('base64url')}`;
    setCookie(c, COOKIE, `${value}.${sign(value)}`, { ...cookieOptions(c), maxAge: TTL });
    return c.json({ authenticated: true });
  });
  app.post('/api/auth/logout', (c) => {
    const token = getCookie(c, COOKIE) ?? '';
    if (valid(token)) revoke(token);
    setCookie(c, COOKIE, '', { ...cookieOptions(c), maxAge: 0 });
    return c.json({ authenticated: false });
  });
  return app;
}
