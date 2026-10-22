import { HttpError } from './errors.ts';

/**
 * Parse a `text/event-stream` body into JSON payloads (comments and pings
 * skipped). Used by the gateway when it needs to look inside an agent-server
 * stream; plain proxying should pipe the body through untouched.
 *
 * Lines end with `\n` or `\r\n`. An event without a terminating blank line when
 * the body ends is discarded, as the SSE spec requires. An aborted `signal`
 * cancels the body and throws its reason. A payload that is not JSON throws
 * `HttpError` 502 (`bad_event`).
 */
export async function* readSse<E = unknown>(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<E> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let buffer = '';
  let data: string[] = [];
  const dispatch = (): E | undefined => {
    if (data.length === 0) return undefined;
    const payload = data.join('\n');
    data = [];
    try {
      return JSON.parse(payload) as E;
    } catch {
      throw new HttpError(502, 'Malformed server-sent event payload', 'bad_event');
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (line === '') {
          const event = dispatch();
          if (event !== undefined) yield event;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        if (field !== 'data') continue;
        const raw = colon === -1 ? '' : line.slice(colon + 1);
        data.push(raw.startsWith(' ') ? raw.slice(1) : raw);
      }
    }
    if (signal?.aborted) throw signal.reason;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
  }
}
