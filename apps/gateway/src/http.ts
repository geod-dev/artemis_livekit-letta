import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { randomUUID } from 'node:crypto';
import { GatewayClientError } from './agent-server/client.ts';

/** Largest request body the gateway relays to the agent-server (uploads have their own route). */
export const PROXY_BODY_LIMIT = 4 * 1024 * 1024;
/** Largest JSON object the gateway parses from a request body. */
const JSON_BODY_LIMIT = 1_000_000;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const GENERIC_MESSAGE = 'The request could not be completed';

/**
 * The error envelope of the API. A 4xx shows its message only when the caller
 * wrote it on purpose (a string, or a typed HttpError or HTTPException); any other
 * error is a generic message. A 5xx is always masked and gets a request id.
 */
export function errorResponse(error: unknown, status = 500): Response {
  const typed =
    error instanceof HttpError ||
    error instanceof HTTPException ||
    error instanceof GatewayClientError;
  const resolvedStatus = typed ? error.status : status;
  let message = GENERIC_MESSAGE;
  if (resolvedStatus < 500) {
    if (typeof error === 'string') message = error;
    else if (typed && error.message) message = error.message;
  }
  const requestId = resolvedStatus >= 500 ? randomUUID() : undefined;
  if (requestId)
    console.error(
      `[api] request=${requestId} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
  return Response.json(
    { error: message, ...(requestId ? { requestId } : {}) },
    { status: resolvedStatus }
  );
}

type BoundedBody = { ok: true; body: Uint8Array } | { ok: false; status: 400 | 413; error: string };

/** Reads a request body into memory, stopping as soon as it passes `maxBytes`. */
async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    return { ok: false, status: 413, error: 'Request body is too large' };
  }
  if (!request.body) return { ok: true, body: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: 'Request body is too large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, body: Buffer.concat(chunks, size) };
}

/**
 * Middleware for a route's request body: it is counted while it streams, and a
 * request over `maxBytes` is refused (413) before anything parses it.
 */
export function requestLimit(maxBytes: number): MiddlewareHandler {
  return bodyLimit({
    maxSize: maxBytes,
    onError: () => errorResponse('Request body is too large', 413),
  });
}

/** Parse a complete JSON object before callers inspect any of its fields. */
export async function jsonObject(
  req: Request,
  maxBytes = JSON_BODY_LIMIT
): Promise<Record<string, unknown> | null> {
  const bounded = await readBoundedBody(req, maxBytes);
  if (!bounded.ok) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bounded.body).toString('utf8'));
  } catch {
    return null;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The token of an `Authorization: Bearer` header; any other scheme has no bearer token. */
export function bearerToken(req: Request): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
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
