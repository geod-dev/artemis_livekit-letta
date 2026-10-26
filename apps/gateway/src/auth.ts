import { type Context, Hono, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { bearerToken } from './http.ts';
import { VOICE_AGENT_PATH_PREFIX } from './routes/voice.ts';
import { isLocalOrPrivateAddress, sameSecret } from './security.ts';

const COOKIE = 'artemis_session';
const TTL = 90 * 24 * 60 * 60;
/** Failed logins are counted per window: per client address, and across every client. */
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_LIMIT_PER_CLIENT = 10;
const LOGIN_LIMIT_GLOBAL = 50;
/** The lockout of the global ceiling doubles on each repeat, up to this length. */
const MAX_GLOBAL_LOCKOUT_MS = 15 * 60_000;
/** Client windows kept in memory; the oldest is dropped when the map is full. */
const MAX_TRACKED_CLIENTS = 10_000;
/** Expired client windows are swept once per this many new windows, not on every request. */
const CLIENT_SWEEP_EVERY = 1_000;

/** The login gate's hand-off to the login route: the client window its attempt holds a place in. */
type LoginEnv = { Variables: { loginWindow: FailureWindow } };

export interface SessionAuthOptions {
  password: string;
  deviceToken: string;
  /** The gateway-only state root; logged-out sessions persist under its auth/ folder. */
  dataDir: string;
  /** The socket address of a request, read by the Node server (absent in-process, so unknown). */
  peerAddress?: (c: Context) => string | undefined;
  /**
   * The reverse proxy's addresses or CIDR ranges (TRUSTED_PROXIES), whose X-Real-IP is honoured.
   * Empty means unset: any loopback or private peer is trusted, as before.
   */
  trustedProxies?: string[];
}

/** An IP address without the IPv4-mapped prefix that dual-stack sockets report, and its family (0 if invalid). */
function bareAddress(address: string): { address: string; family: number } {
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
  return { address: bare, family: isIP(bare) };
}

/** The configured proxy addresses and ranges, as a set to test a socket peer against. */
function proxyList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/');
    const { address: bare, family } = bareAddress(address);
    if (!family)
      throw new Error(`TRUSTED_PROXIES must hold IP addresses or CIDR ranges, not "${entry}"`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(bare, type);
    else list.addSubnet(bare, Number(prefix), type);
  }
  return list;
}

/** Failed logins in the current window, for one client address. */
class FailureWindow {
  private failures = 0;
  private resetAt = 0;
  /** Logins whose bodies are still being read; each takes a place in the window until it settles. */
  private inFlight = 0;

  constructor(private readonly limit: number) {}

  /** True while failures and logins in flight reach the limit; a window that has run out starts again. */
  blocked(now: number): boolean {
    if (this.expired(now)) {
      this.failures = 0;
      this.resetAt = now + LOGIN_WINDOW_MS;
    }
    return this.failures + this.inFlight >= this.limit;
  }

  /** Counts a login before its body is read, so a withheld body cannot outrun the limit. */
  begin(): void {
    this.inFlight++;
  }

  /** Settles a login counted by begin(); its failure, if any, has already been recorded. */
  end(): void {
    this.inFlight--;
  }

  fail(): void {
    this.failures++;
  }

  expired(now: number): boolean {
    return now >= this.resetAt;
  }

  /** Milliseconds until this window starts again; 0 once it has run out. */
  remainingMs(now: number): number {
    return Math.max(0, this.resetAt - now);
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
  /** Logins whose bodies are still being read; they count toward the ceiling until they settle. */
  private inFlight = 0;

  /** Milliseconds until logins are accepted again; 0 while they are open. */
  lockedFor(now: number): number {
    return Math.max(0, this.lockedUntil - now);
  }

  /**
   * Milliseconds until a login may be tried: the lockout, or the window's end once failures and
   * logins in flight fill it. 0 while logins are open.
   */
  waitFor(now: number): number {
    const locked = this.lockedFor(now);
    if (locked > 0) return locked;
    const failures = now >= this.windowEnd ? 0 : this.failures;
    if (failures + this.inFlight < LOGIN_LIMIT_GLOBAL) return 0;
    return now < this.windowEnd ? this.windowEnd - now : LOGIN_WINDOW_MS;
  }

  /** Counts a login before its body is read; see FailureWindow.begin. */
  begin(): void {
    this.inFlight++;
  }

  /** Settles a login counted by begin(). */
  end(): void {
    this.inFlight--;
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

/** Revoked session tokens, by nonce with their expiry (epoch seconds), kept on disk across restarts. */
class RevokedSessions {
  private readonly entries = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error(`${file} must hold a JSON object of revoked sessions`);
    for (const [nonce, until] of Object.entries(parsed)) {
      if (typeof until !== 'number') throw new Error(`${file} holds a non-numeric expiry`);
      this.entries.set(nonce, until);
    }
    this.prune();
  }

  has(nonce: string): boolean {
    return this.entries.has(nonce);
  }

  /** Revokes a token and writes the whole set before the caller answers the logout. */
  revoke(nonce: string, expires: number): Promise<void> {
    this.entries.set(nonce, expires);
    // Writes run one after another, so a later snapshot never lands before an earlier one.
    const write = this.queue.then(() => this.persist());
    this.queue = write.catch(() => {});
    return write;
  }

  private prune(): void {
    const now = Date.now() / 1000;
    for (const [nonce, until] of this.entries) if (until <= now) this.entries.delete(nonce);
  }

  /** Temporary file with a unique name, flushed before the rename replaces the state. */
  private async persist(): Promise<void> {
    this.prune();
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'w');
      try {
        await handle.writeFile(JSON.stringify(Object.fromEntries(this.entries)));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

/**
 * The gateway's session gate: the /api middleware (no-store, origin, session and device
 * checks) and the /api/auth routes. Voice-agent paths pass the gate; their router checks
 * the voice token itself (see VOICE_AGENT_PATH_PREFIX).
 */
export function createSessionAuth(options: SessionAuthOptions): Hono {
  const { password, deviceToken, dataDir } = options;
  if (!password) throw new Error('Set ARTEMIS_PASSWORD in .env before starting the gateway');
  // The cookie is signed with a key derived from the password, so the password never signs directly.
  const signingKey = createHmac('sha256', password).update('artemis-session-signing-key').digest();
  const sign = (value: string) =>
    createHmac('sha256', signingKey).update(`artemis-session:${value}`).digest('base64url');
  const revoked = new RevokedSessions(join(dataDir, 'auth', 'revoked.json'));
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
  const peerAddress = (c: Context): string | undefined => {
    try {
      return options.peerAddress?.(c);
    } catch {
      return undefined;
    }
  };
  // With TRUSTED_PROXIES set, only those peers count; unset, every loopback or private peer does.
  const trusted = options.trustedProxies?.length ? proxyList(options.trustedProxies) : undefined;
  const isTrustedProxy = (peer: string): boolean => {
    if (!trusted) return isLocalOrPrivateAddress(peer);
    const { address, family } = bareAddress(peer);
    return family !== 0 && trusted.check(address, family === 6 ? 'ipv6' : 'ipv4');
  };
  /**
   * The address a login failure is counted against. nginx sets X-Real-IP from the socket
   * and overwrites any value the client sent, so the header is read only when the direct
   * peer is a trusted proxy. Otherwise the socket address counts.
   */
  const clientAddress = (c: Context): string => {
    const peer = peerAddress(c);
    const forwarded = c.req.header('X-Real-IP');
    if (forwarded && peer && isTrustedProxy(peer)) return forwarded;
    return peer ?? 'unknown';
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
  let clientsCreated = 0;
  const clientWindow = (key: string): FailureWindow => {
    const known = clients.get(key);
    if (known) return known;
    const window = new FailureWindow(LOGIN_LIMIT_PER_CLIENT);
    if (++clientsCreated % CLIENT_SWEEP_EVERY === 0) {
      const now = Date.now();
      for (const [id, old] of clients) if (old.expired(now)) clients.delete(id);
    }
    // Full of unexpired windows: the oldest is replaced, so every client keeps a counted window.
    if (clients.size >= MAX_TRACKED_CLIENTS) clients.delete(clients.keys().next().value!);
    clients.set(key, window);
    return window;
  };
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    if (path.startsWith(VOICE_AGENT_PATH_PREFIX)) return next();
    const device =
      path.startsWith('/api/devices/') && sameSecret(bearerToken(c.req.raw), deviceToken);
    if (device) return next();
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
  // Runs before bodyLimit, which reads the whole body before the route. The attempt takes its place
  // here, from the headers, so a request that withholds its body counts like any other. The place
  // is given back in finally, once the handler has recorded any failure.
  const loginGate = async (c: Context<LoginEnv>, next: Next) => {
    const now = Date.now();
    const client = clientWindow(clientAddress(c));
    const globalWait = everyone.waitFor(now);
    if (globalWait > 0 || client.blocked(now)) {
      const wait = globalWait > 0 ? globalWait : client.remainingMs(now);
      c.header('Retry-After', String(Math.ceil(wait / 1000)));
      return c.json({ error: 'Too many attempts. Try again later.' }, 429);
    }
    client.begin();
    everyone.begin();
    c.set('loginWindow', client);
    try {
      await next();
    } finally {
      client.end();
      everyone.end();
    }
  };
  app.post('/api/auth/login', loginGate, bodyLimit({ maxSize: 4096 }), async (c) => {
    const client = c.get('loginWindow') as FailureWindow;
    const body = await c.req.json().catch(() => null);
    if (typeof body?.password !== 'string' || !sameSecret(body.password, password)) {
      everyone.fail(Date.now());
      client.fail();
      return c.json({ error: 'Incorrect password.' }, 401);
    }
    everyone.succeed();
    const value = `${Math.floor(Date.now() / 1000) + TTL}.${randomBytes(24).toString('base64url')}`;
    setCookie(c, COOKIE, `${value}.${sign(value)}`, { ...cookieOptions(c), maxAge: TTL });
    return c.json({ authenticated: true });
  });
  app.post('/api/auth/logout', async (c) => {
    const token = getCookie(c, COOKIE) ?? '';
    if (valid(token)) {
      const [expires = '', nonce = ''] = token.split('.');
      await revoked.revoke(nonce, Number(expires));
    }
    setCookie(c, COOKIE, '', { ...cookieOptions(c), maxAge: 0 });
    return c.json({ authenticated: false });
  });
  return app;
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
