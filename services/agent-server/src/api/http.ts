import { AppError } from '@artemis/core';
import { hasBearer, jsonObject } from '@artemis/http';
import type { Context, MiddlewareHandler } from 'hono';

/** `Authorization: Bearer AGENT_SERVER_TOKEN` (constant-time). */
export function requireBearer(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!hasBearer(c.req.raw, token)) throw new AppError('unauthorized', 'Unauthorized', 401);
    await next();
  };
}

/** A required JSON object body, or 400 `invalid_body`. */
export async function requireBody(request: Request, message = 'Body must be a JSON object'): Promise<Record<string, unknown>> {
  const body = await jsonObject(request);
  if (!body) throw new AppError('invalid_body', message, 400);
  return body;
}

/** An optional JSON object body: an empty body is `{}`, a malformed one is 400. */
export async function optionalBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  const text = await request.clone().text().catch(() => '');
  if (text.trim() === '') return {};
  return requireBody(request);
}

/** A string field with a length bound, or 400 `invalid_field`. */
export function requireString(body: Record<string, unknown>, field: string, max: number, min = 1): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new AppError('invalid_field', `${field} must be a string of ${min} to ${max} characters`, 400);
  }
  return value;
}

/** Optional `limit` query parameter (1..max), default `fallback`. */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new AppError('invalid_limit', `limit must be an integer from 1 to ${max}`, 400);
  }
  return value;
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
