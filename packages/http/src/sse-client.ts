import { notImplemented } from '@artemis/core';

/**
 * Parse a `text/event-stream` body into JSON payloads (comments and pings
 * skipped). Used by the gateway when it needs to look inside an agent-server
 * stream; plain proxying should pipe the body through untouched.
 */
export function readSse<E = unknown>(_body: ReadableStream<Uint8Array>, _signal?: AbortSignal): AsyncIterable<E> {
  return notImplemented('readSse');
}
