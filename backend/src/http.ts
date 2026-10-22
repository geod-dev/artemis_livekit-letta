import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { config } from './assistant/config';

/** Largest request body the gateway relays to the agent-server (uploads have their own route). */
export const PROXY_BODY_LIMIT = 4 * 1024 * 1024;

export class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'HttpError'; }
}

export function errorResponse(error: unknown, status = 500): Response {
  const resolvedStatus = error instanceof HttpError ? error.status : status;
  const message = resolvedStatus >= 500 ? 'The request could not be completed' :
    error instanceof Error ? error.message : String(error);
  const requestId = resolvedStatus >= 500 ? randomUUID() : undefined;
  if (requestId) console.error(`[api] request=${requestId} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  return Response.json({ error: message, ...(requestId ? { requestId } : {}) }, { status: resolvedStatus });
}

/** Parse a complete JSON object before callers inspect any of its fields. */
export async function jsonObject(req: Request, maxBytes = 1_000_000): Promise<Record<string, unknown> | null> {
  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
  const text = await req.text().catch(() => '');
  if (new TextEncoder().encode(text).byteLength > maxBytes) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The voice agent authenticates to the gateway with a shared bearer token. */
export function isVoiceAgent(req: Request): boolean {
  return hasBearer(req, config.voiceGatewayToken);
}

function hasBearer(req: Request, token: string): boolean {
  const header = req.headers.get('authorization') ?? '';
  const presented = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * Error handler of the gateway's API routers. API errors keep their status and
 * message; a client that already left gets no body (its request was aborted).
 */
export function routeError(error: Error, c: Context): Response {
  if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
  return errorResponse(error);
}

/** The gateway's own API request of an agent-server route: the same path, plus the query string. */
export function withQuery(c: Context, path: string): string {
  return `${path}${new URL(c.req.url).search}`;
}
