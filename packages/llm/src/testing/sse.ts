/** Test helpers: fake `fetch` that replays server-sent events. No network is used. */

export interface SseEvent {
  /** Anthropic sends `event:` lines; OpenAI-compatible hosts send data lines only. */
  event?: string;
  data: unknown;
}

export interface RecordedRequest {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

export function sseBody(events: SseEvent[], options: { done?: boolean } = {}): string {
  const frames = events.map(({ event, data }) => {
    const lines = event ? `event: ${event}\n` : '';
    return `${lines}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  });
  if (options.done) frames.push('data: [DONE]\n\n');
  return frames.join('');
}

export function sseResponse(events: SseEvent[], options: { done?: boolean } = {}): Response {
  return new Response(sseBody(events, options), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fetch that records each request and answers with `respond`. The body stays open
 * until the request signal aborts, like a real network stream (see `openStream`).
 */
export function recordingFetch(respond: (request: RecordedRequest, init: RequestInit) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request: RecordedRequest = {
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    };
    requests.push(request);
    return respond(request, init ?? {});
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, requests };
}

/**
 * A streaming body that delivers `prefix` and then stays open until the request
 * signal aborts (the abort errors the stream, as a real fetch does).
 */
export function openStream(prefix: string, init: RequestInit): Response {
  const encoder = new TextEncoder();
  const signal = init.signal ?? undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(prefix));
      signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
