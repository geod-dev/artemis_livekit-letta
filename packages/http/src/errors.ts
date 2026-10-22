import { notImplemented } from '@artemis/core';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** `{error, code?}` JSON response; maps `AppError`/`HttpError` statuses, hides internals for 5xx. */
export function errorResponse(_error: unknown, _status?: number): Response {
  return notImplemented('errorResponse');
}

/** Read a bounded JSON object body; null when the body is not a JSON object. */
export function jsonObject(_request: Request, _maxBytes?: number): Promise<Record<string, unknown> | null> {
  return notImplemented('jsonObject');
}
