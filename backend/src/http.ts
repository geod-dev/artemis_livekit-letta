import { randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './assistant/config';

export class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'HttpError'; }
}

export function errorResponse(error: unknown, status = 500): Response {
  const resolvedStatus = error instanceof HttpError ? error.status : status;
  const message = resolvedStatus >= 500 ? 'The request could not be completed' :
    error instanceof Error ? error.message : String(error);
  const requestId = resolvedStatus >= 500 ? randomUUID() : undefined;
  if (requestId) console.error(`[api] request=${requestId} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  return Response.json({ error: message, ...(requestId ? { requestId } : {}) }, { status: resolvedStatus });
}

/** Parse a complete JSON object before callers inspect any of its fields. */
export async function jsonObject(req: Request, maxBytes = 1_000_000): Promise<Record<string, unknown> | null> {
  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
  const text = await req.text().catch(() => '');
  if (new TextEncoder().encode(text).byteLength > maxBytes) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The voice agent authenticates to the gateway with a shared bearer token. */
export function isVoiceAgent(req: Request): boolean {
  return hasBearer(req, config.voiceGatewayToken);
}

/** The Letta server (its notifications mod) presents the shared Letta token. */
export function isLettaServer(req: Request): boolean {
  return Boolean(config.letta.token) && hasBearer(req, config.letta.token!);
}

function hasBearer(req: Request, token: string): boolean {
  const header = req.headers.get('authorization') ?? '';
  const presented = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** A server-sent event stream; `start` receives `send` and returns its cleanup. */
export function eventStream(
  req: Request,
  start: (send: (data: unknown) => void) => () => void
): Response {
  const encoder = new TextEncoder();
  const MAX_EVENT_BYTES = 256 * 1024;
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let stop: () => void = () => {};
      const onAbort = () => close(true);
      const close = (closeController: boolean) => {
        if (closed) return;
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        req.signal.removeEventListener('abort', onAbort);
        try { stop(); } catch (error) { console.warn('[sse] subscriber cleanup failed', error); }
        if (closeController) { try { controller.close(); } catch {} }
      };
      const write = (chunk: string) => {
        if (closed) return;
        if (encoder.encode(chunk).byteLength > MAX_EVENT_BYTES || (controller.desiredSize !== null && controller.desiredSize <= 0)) {
          close(true);
          return;
        }
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close(false);
        }
      };
      const keepAlive = setInterval(() => write(': ping\n\n'), 15_000);
      cleanup = () => close(false);
      req.signal.addEventListener('abort', onAbort, { once: true });
      if (req.signal.aborted) { close(true); return; }
      try {
        stop = start((data) => write(`data: ${JSON.stringify(data)}\n\n`));
        // A synchronous snapshot may overflow before start returns its cleanup.
        if (closed) {
          try { stop(); } catch (error) { console.warn('[sse] subscriber cleanup failed', error); }
          return;
        }
      } catch (error) {
        close(true);
        console.error('[sse] subscriber startup failed', error);
        return;
      }
      write(': connected\n\n');
    },
    cancel() {
      cleanup();
    },
  }, { highWaterMark: 128 });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
