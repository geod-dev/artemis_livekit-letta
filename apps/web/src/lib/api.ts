import { CHAT_HTTP } from '@artemis/contracts/chat-http';

/**
 * The one client for every browser-to-gateway request: fetch, EventSource and
 * the route paths come from `@artemis/contracts/chat-http`, and status and JSON
 * errors are reported the same way everywhere.
 */
class ApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The path of one conversation, or of a sub-route of it (`suffix` starts with '/'). */
export const conversationRoute = (id: string, suffix = '') =>
  `${CHAT_HTTP.conversations}/${encodeURIComponent(id)}${suffix}`;

/** Fetch a gateway path; a request that never got a response becomes an ApiError. */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      error instanceof Error ? error.message : 'Unable to connect to the server',
      null
    );
  }
}

/** Open a server-sent event stream on a gateway path. */
export function openEventSource(path: string): EventSource {
  return new EventSource(path);
}

export async function responseJson<T>(
  response: Response,
  validate: (value: unknown) => value is T,
  fallback: string
): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiError(response.ok ? 'Server returned invalid JSON' : fallback, response.status);
  }
  if (!response.ok) {
    const message =
      value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
        ? value.error
        : fallback;
    throw new ApiError(message, response.status);
  }
  if (!validate(value))
    throw new ApiError('Server returned an unexpected response', response.status);
  return value;
}

export async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  validate: (value: unknown) => value is T,
  fallback: string
): Promise<T> {
  return responseJson(await apiFetch(input, init), validate, fallback);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
