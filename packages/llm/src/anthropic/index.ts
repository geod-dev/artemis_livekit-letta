import { notImplemented } from '@artemis/core';
import { LlmProvider, type ModelInfo } from '../provider.ts';
import type { LlmRequest, LlmStreamEvent } from '../types.ts';

export interface AnthropicProviderOptions {
  /** Defaults to the SDK's own credential resolution (ANTHROPIC_API_KEY ...). */
  apiKey?: string;
  baseUrl?: string;
  maxRetries?: number;
  /** TTL of cache breakpoints (default 5m). */
  cacheTtl?: '5m' | '1h';
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

  constructor(readonly options: AnthropicProviderOptions = {}) {
    super();
  }

  stream(_request: LlmRequest, _signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    return notImplemented('AnthropicLlmProvider.stream');
  }

  modelInfo(_model: string): ModelInfo {
    return notImplemented('AnthropicLlmProvider.modelInfo');
  }
}
