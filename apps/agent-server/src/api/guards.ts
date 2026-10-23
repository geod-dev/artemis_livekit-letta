import { NotFoundError } from '@artemis/core';
import type { Context, Next } from 'hono';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Call ids are `prefixedId('call')` from @artemis/core: `call_` and 32 hex digits. */
const CALL_ID_PATTERN = /^call_[0-9a-f]{32}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isCallId(value: string): boolean {
  return CALL_ID_PATTERN.test(value);
}

/**
 * Route guard for a path parameter that is a uuid key (conversation, background update).
 * A value that is not a uuid cannot name a row, so it answers 404 here instead of letting
 * Postgres reject the cast as a 500. `reserved` lists literal segments that share the position.
 */
export function requireUuidParam(name: string, what: string, reserved: readonly string[] = []) {
  return async (c: Context, next: Next) => {
    const value = c.req.param(name) ?? '';
    if (!reserved.includes(value) && !isUuid(value)) throw new NotFoundError(what);
    await next();
  };
}
