import type { Hono } from 'hono';

/** Reads an SSE response incrementally, with a deadline on every read. */
export class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private text = '';

  constructor(response: Response) {
    this.reader = response.body!.getReader();
  }

  async until(done: (text: string) => boolean, timeoutMs = 5_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!done(this.text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`SSE timed out after ${timeoutMs} ms`);
      let timer: NodeJS.Timeout | undefined;
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`SSE read timed out after ${timeoutMs} ms`)), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) throw new Error('SSE stream closed before the expected event');
      this.text += this.decoder.decode(chunk.value, { stream: true });
    }
    return this.text;
  }

  /** The `data:` payloads of the complete frames read so far. */
  frames(): Array<Record<string, unknown>> {
    return this.text
      .split('\n\n')
      .slice(0, -1)
      .flatMap((block) => block.split('\n'))
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

export interface RequestOptions {
  body?: unknown;
  raw?: string;
  /** The bearer token to send; omitted or null sends no Authorization header. */
  token?: string | null;
  headers?: Record<string, string>;
}

/** An in-process request to the app: a JSON body is serialised, a raw body is sent as is. */
export async function sendRequest(app: Hono, method: string, path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body = options.raw;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  return app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) });
}
