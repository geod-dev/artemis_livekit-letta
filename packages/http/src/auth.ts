import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Constant-time check of `Authorization: Bearer <token>`. Both sides are hashed
 * first so the comparison runs over equal-length buffers and leaks no length.
 * An empty expected token never matches.
 */
export function hasBearer(request: Request, token: string): boolean {
  if (!token) return false;
  const match = BEARER.exec(request.headers.get('authorization') ?? '');
  if (!match?.[1]) return false;
  const presented = createHash('sha256').update(match[1].trim()).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(presented, expected);
}
