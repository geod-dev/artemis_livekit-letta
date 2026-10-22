import { notImplemented } from '@artemis/core';

/** Constant-time check of `Authorization: Bearer <token>`. */
export function hasBearer(_request: Request, _token: string): boolean {
  return notImplemented('hasBearer');
}
