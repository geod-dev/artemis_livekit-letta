import { timingSafeEqual } from 'node:crypto';
import { config } from './assistant/config';

export function errorResponse(error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (status >= 500) console.error('[api]', error);
  return Response.json({ error: message }, { status });
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
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const stop = start((data) => write(`data: ${JSON.stringify(data)}\n\n`));
      const keepAlive = setInterval(() => write(': ping\n\n'), 15_000);
      cleanup = () => {
        clearInterval(keepAlive);
        stop();
        cleanup = () => {};
      };
      req.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
      write(': connected\n\n');
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
