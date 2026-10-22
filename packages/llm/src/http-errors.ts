import { LlmError } from './provider.ts';

/** A transport failure (no HTTP response): retryable. */
export function llmNetworkError(message: string, cause?: unknown): LlmError {
  return new LlmError('network', message, true, cause === undefined ? undefined : { cause });
}

/**
 * Maps an HTTP status from any vendor SDK to a provider-neutral `LlmError`.
 * Vendor adapters detect their SDK's error classes and call this with the status.
 */
export function llmErrorFromHttp(status: number | undefined, message: string, cause?: unknown): LlmError {
  const options = cause === undefined ? undefined : { cause };
  if (status === undefined) return new LlmError('unknown', message, false, options);
  if (status === 429) return new LlmError('rate_limited', message, true, options);
  if (status === 529 || status === 503) return new LlmError('overloaded', message, true, options);
  if (status === 401 || status === 403) return new LlmError('auth', message, false, options);
  if (status === 400 && CONTEXT_OVERFLOW.test(message)) {
    return new LlmError('context_overflow', message, false, options);
  }
  if (status === 408) return new LlmError('network', message, true, options);
  if (status >= 500) return new LlmError('unknown', message, true, options);
  return new LlmError('invalid_request', message, false, options);
}

const CONTEXT_OVERFLOW = /prompt is too long|context (length|window)|too many tokens|maximum context/i;
