import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import { ResponseAccumulator } from '../accumulator.ts';
import { llmErrorFromHttp, llmNetworkError } from '../http-errors.ts';
import { LlmError, LlmProvider, type ModelInfo } from '../provider.ts';
import { runModelStep } from '../stream-runner.ts';
import type { LlmRequest, LlmStreamEvent } from '../types.ts';
import { openAiCompatibleModelInfo } from './models.ts';
import { buildChatRequest } from './request.ts';
import { OpenAiStreamMapper } from './stream.ts';

export interface OpenAiCompatibleProviderOptions {
  /** Base URL used as-is (Telnyx: https://api.telnyx.com/v2/ai/openai). No `/v1` is appended. */
  baseUrl: string;
  apiKey: string;
  /** Static model metadata: the endpoint does not report context windows. */
  models?: Record<string, Partial<ModelInfo>>;
  maxRetries?: number;
  /** Transport override (tests use a fake fetch that replays recorded SSE). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Chat Completions through the official `openai` SDK with a custom `baseURL`.
 * - `effort` -> `reasoning_effort` (GLM on Telnyx supports `high` only: workers always send `high`).
 * - `reasoning_content` deltas -> `reasoning_delta`; reasoning is not replayed.
 * - images -> `image_url` data URLs; tool results -> `role:'tool'` messages.
 * - `provider` blocks of other vendors are dropped; `cache`/`compaction` ignored.
 */
export class OpenAiCompatibleLlmProvider extends LlmProvider {
  readonly id = 'openai-compatible';
  private readonly client: OpenAI;

  constructor(readonly options: OpenAiCompatibleProviderOptions) {
    super();
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      maxRetries: options.maxRetries,
      fetch: options.fetch,
    });
  }

  stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const acc = new ResponseAccumulator(request.model);
    const mapper = new OpenAiStreamMapper(acc);
    return runModelStep(acc, {
      open: () => this.client.chat.completions.create(buildChatRequest(request), { signal }),
      apply: chunk => mapper.apply(chunk),
      stopReason: () => mapper.stopReason,
      isAbort: error => isAbort(error, signal),
      toError,
    });
  }

  modelInfo(model: string): ModelInfo {
    return openAiCompatibleModelInfo(model, this.options.models);
  }
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || error instanceof APIUserAbortError;
}

function toError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof APIConnectionError) {
    return llmNetworkError(error.message, error);
  }
  if (error instanceof APIError) {
    return llmErrorFromHttp(error.status, error.message, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError('unknown', message, false, error === undefined ? undefined : { cause: error });
}
