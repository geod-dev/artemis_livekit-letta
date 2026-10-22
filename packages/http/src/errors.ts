import { AppError, consoleLogger } from '@artemis/core';

const logger = consoleLogger('http');

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

/**
 * `{error, code?, requestId?}` JSON response. `AppError`/`HttpError` carry their
 * own status; other errors use `status` (default 500). 5xx responses hide the
 * message, return a request id and log the stack instead.
 */
export function errorResponse(error: unknown, status = 500): Response {
  const declared = error instanceof AppError || error instanceof HttpError ? error.status : status;
  const resolved = Number.isInteger(declared) && declared >= 400 && declared <= 599 ? declared : 500;
  const code = error instanceof AppError || error instanceof HttpError ? error.code : undefined;
  if (resolved >= 500) {
    const requestId = crypto.randomUUID();
    logger.error(`request=${requestId} failed`, {
      stack: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return Response.json(
      { error: 'The request could not be completed', ...(code ? { code } : {}), requestId },
      { status: resolved }
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: message, ...(code ? { code } : {}) }, { status: resolved });
}

/**
 * Read a bounded JSON object body; null when the body is missing, too large,
 * not valid JSON, or not a JSON object. Bytes are counted while streaming, so
 * a body without `Content-Length` cannot exceed `maxBytes` in memory.
 */
export async function jsonObject(request: Request, maxBytes = 1_000_000): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const bytes = await readBounded(request, maxBytes);
  if (!bytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readBounded(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
