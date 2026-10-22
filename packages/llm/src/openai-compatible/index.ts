import { notImplemented } from '@artemis/core';
import { LlmProvider, type ModelInfo } from '../provider.ts';
import type { LlmRequest, LlmStreamEvent } from '../types.ts';

export interface OpenAiCompatibleProviderOptions {
  /** Base URL used as-is (Telnyx: https://api.telnyx.com/v2/ai/openai). No `/v1` is appended. */
  baseUrl: string;
  apiKey: string;
  /** Static model metadata: the endpoint does not report context windows. */
  models?: Record<string, Partial<ModelInfo>>;
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

  constructor(readonly options: OpenAiCompatibleProviderOptions) {
    super();
  }

  stream(_request: LlmRequest, _signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    return notImplemented('OpenAiCompatibleLlmProvider.stream');
  }

  modelInfo(_model: string): ModelInfo {
    return notImplemented('OpenAiCompatibleLlmProvider.modelInfo');
  }
}
