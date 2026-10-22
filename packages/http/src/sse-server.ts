import { consoleLogger } from '@artemis/core';

export interface EventStreamOptions {
  /** `: ping` comment period (default 15 s). */
  keepAliveMs?: number;
  /** A larger serialized event closes the stream (default 256 KB). */
  maxEventBytes?: number;
}

const logger = consoleLogger('sse');
const DEFAULT_KEEP_ALIVE_MS = 15_000;
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;

/**
 * Server-Sent Events response (port of backend/src/http.ts `eventStream`):
 * `data: <JSON>\n\n` frames, `: connected` first, keepalive pings, closes on
 * oversize events or backpressure. `start` receives `send` and `close` and may
 * return the cleanup to run when the stream ends (also when it closed during start).
 */
export function eventStream<E>(
  request: Request,
  start: (send: (event: E) => void, close: () => void) => (() => void) | void,
  options: EventStreamOptions = {}
): Response {
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const encoder = new TextEncoder();
  let cancelStream: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let stop: (() => void) | undefined;
        const runStop = () => {
          try {
            stop?.();
          } catch (error) {
            logger.warn('subscriber cleanup failed', { error: String(error) });
          }
        };
        const close = (closeController: boolean) => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          request.signal.removeEventListener('abort', onAbort);
          runStop();
          if (closeController) {
            try {
              controller.close();
            } catch {
              // Already closed by the consumer.
            }
          }
        };
        const onAbort = () => close(true);
        const write = (chunk: string) => {
          if (closed) return;
          if (
            encoder.encode(chunk).byteLength > maxEventBytes ||
            (controller.desiredSize !== null && controller.desiredSize <= 0)
          ) {
            close(true);
            return;
          }
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            close(false);
          }
        };
        const keepAlive = setInterval(() => write(': ping\n\n'), keepAliveMs);
        cancelStream = () => close(false);
        request.signal.addEventListener('abort', onAbort, { once: true });
        if (request.signal.aborted) {
          close(true);
          return;
        }
        write(': connected\n\n');
        if (closed) return;
        try {
          const cleanup = start((event) => write(`data: ${JSON.stringify(event)}\n\n`), () => close(true));
          if (typeof cleanup === 'function') stop = cleanup;
        } catch (error) {
          logger.error('subscriber startup failed', { error: String(error) });
          close(true);
          return;
        }
        // The subscription may have overflowed or closed while start was running.
        if (closed) runStop();
      },
      cancel() {
        cancelStream();
      },
    },
    { highWaterMark: 128 }
  );
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
