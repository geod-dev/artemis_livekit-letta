import { notImplemented } from '@artemis/core';

export interface EventStreamOptions {
  /** `: ping` comment period (default 15 s). */
  keepAliveMs?: number;
  /** A larger serialized event closes the stream (default 256 KB). */
  maxEventBytes?: number;
}

/**
 * Server-Sent Events response (port of backend/src/http.ts `eventStream`):
 * `data: <JSON>\n\n` frames, `: connected` first, keepalive pings, closes on
 * oversize events or backpressure. `start` receives `send` and returns the
 * cleanup to run when the client disconnects.
 */
export function eventStream<E>(
  _request: Request,
  _start: (send: (event: E) => void, close: () => void) => (() => void) | void,
  _options?: EventStreamOptions
): Response {
  return notImplemented('eventStream');
}
