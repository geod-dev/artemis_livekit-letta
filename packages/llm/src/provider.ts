import { AppError } from '@artemis/core';
import type { LlmRequest, LlmResponse, LlmStreamEvent } from './types.ts';

export interface ModelInfo {
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsImages: boolean;
}

export type LlmErrorCode =
  | 'rate_limited'
  | 'overloaded'
  | 'invalid_request'
  | 'auth'
  | 'context_overflow'
  | 'refusal'
  | 'network'
  | 'no_response'
  | 'unknown';

export class LlmError extends AppError {
  constructor(
    code: LlmErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(code, message, 502, options);
    this.name = 'LlmError';
  }
}

/**
 * One LLM vendor behind the canonical types. Implementations:
 * `AnthropicLlmProvider` (`@artemis/llm/anthropic`) and
 * `OpenAiCompatibleLlmProvider` (`@artemis/llm/openai-compatible`).
 * Only the composition root imports an implementation.
 */
export abstract class LlmProvider {
  /** Handle prefix in `provider/model` strings: `anthropic`, `openai-compatible`. */
  abstract readonly id: string;

  /**
   * Stream one model step. The last event is always `message_end` (also on
   * abort, with `stopReason: 'aborted'` and the partial content). Throws
   * `LlmError` for failures before any output; retries are the provider's job.
   */
  abstract stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent>;

  /** Non-streaming convenience (titles, one-shots): drains `stream`. */
  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    let last: LlmResponse | undefined;
    for await (const event of this.stream(request, signal)) {
      if (event.type === 'message_end') last = event.message;
    }
    if (!last) throw new LlmError('no_response', 'The provider ended without a message', false);
    return last;
  }

  abstract modelInfo(model: string): ModelInfo;
}
