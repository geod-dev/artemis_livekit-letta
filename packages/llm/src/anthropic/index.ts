import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { ResponseAccumulator } from '../accumulator.ts';
import { llmErrorFromHttp, llmNetworkError } from '../http-errors.ts';
import { LlmError, LlmProvider, type ModelInfo } from '../provider.ts';
import { runModelStep } from '../stream-runner.ts';
import type { LlmRequest, LlmStreamEvent } from '../types.ts';
import { anthropicModelInfo } from './models.ts';
import { buildAnthropicCall } from './request.ts';
import { AnthropicStreamMapper, type AnthropicRawEvent } from './stream.ts';

export interface AnthropicProviderOptions {
  /** Defaults to the SDK's own credential resolution (ANTHROPIC_API_KEY ...). */
  apiKey?: string;
  baseUrl?: string;
  maxRetries?: number;
  /** TTL of cache breakpoints (default 5m). */
  cacheTtl?: '5m' | '1h';
  /** Transport override (tests use a fake fetch that replays recorded SSE). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Claude through the official `@anthropic-ai/sdk` (`client.messages.stream`).
 * - `thinking: 'adaptive'` -> `{type:'adaptive', display: showReasoning ? 'summarized' : 'omitted'}`;
 *   `'disabled'` -> `{type:'disabled'}` (Haiku 5.5 accepts it only at effort <= high).
 * - `effort` -> `output_config.effort`. Never sends temperature/top_p/top_k.
 * - `cache` -> `cache_control` breakpoints: last tool, system block, last message (max 4).
 * - `compaction` -> beta `compact-2026-01-12`; compaction blocks round-trip as `provider` blocks.
 * - client tools set `eager_input_streaming: true`; the tool layer validates inputs.
 * - `refusal` / `max_tokens` stop reasons are surfaced, never treated as tool calls.
 * - SDK typed errors -> `LlmError` (429/529/5xx retryable).
 */
export class AnthropicLlmProvider extends LlmProvider {
  readonly id = 'anthropic';
  private readonly client: Anthropic;

  constructor(readonly options: AnthropicProviderOptions = {}) {
    super();
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      maxRetries: options.maxRetries,
      fetch: options.fetch,
    });
  }

  stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const acc = new ResponseAccumulator(request.model);
    const mapper = new AnthropicStreamMapper(acc);
    return runModelStep(acc, {
      open: (): AsyncIterable<AnthropicRawEvent> => {
        const plan = buildAnthropicCall(request, this.options.cacheTtl ?? '5m');
        return plan.beta
          ? this.client.beta.messages.stream(plan.params, { signal })
          : this.client.messages.stream(plan.params, { signal });
      },
      apply: event => mapper.apply(event),
      stopReason: () => mapper.stopReason,
      isAbort: error => isAbort(error, signal),
      toError,
    });
  }

  modelInfo(model: string): ModelInfo {
    return anthropicModelInfo(model);
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
