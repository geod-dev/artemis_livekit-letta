import { AppError } from '@artemis/core';
import { hasBearer } from '@artemis/http';
import type { Context, MiddlewareHandler } from 'hono';

/** Authentication and response helpers. Request parsing and validation live in `validation.ts`. */

/** `Authorization: Bearer AGENT_SERVER_TOKEN` (constant-time). */
export function requireBearer(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!hasBearer(c.req.raw, token)) throw new AppError('unauthorized', 'Unauthorized', 401);
    await next();
  };
}

/** A JSON response with an optional cursor header (`X-Next-Cursor`). */
export function pageResponse<T>(items: T[], nextCursor: string | null): Response {
  return Response.json(items, nextCursor ? { headers: { 'X-Next-Cursor': nextCursor } } : {});
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** Identity of an `If-Match` header: quotes and weak prefix removed. Null when absent. */
export function ifMatchRevision(c: Context): string | null {
  const raw = c.req.header('If-Match');
  if (!raw) return null;
  return raw.replace(/^W\//, '').replace(/^"|"$/g, '');
}
