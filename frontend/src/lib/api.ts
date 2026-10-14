/** Small fetch helpers with consistent status and JSON handling. */
export class ApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      error instanceof Error ? error.message : 'Unable to connect to the server',
      null
    );
  }
  return responseJson(response, validate, fallback);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
