import { LlmProvider, type ModelInfo } from '../provider.ts';
import type { LlmRequest, LlmStreamEvent } from '../types.ts';

/** One scripted model call: fixed events, or a generator that may react to the request and signal. */
export type StreamScript =
  LlmStreamEvent[] | ((request: LlmRequest, signal: AbortSignal) => AsyncGenerator<LlmStreamEvent>);

/** Scripted `LlmProvider`: each `stream` call consumes the next script entry and records its request. */
export class FakeProvider extends LlmProvider {
  readonly requests: LlmRequest[] = [];
  private next = 0;

  constructor(
    private readonly script: StreamScript[],
    readonly id = 'fake'
  ) {
    super();
  }

  async *stream(request: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmStreamEvent> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const step = this.script[this.next];
    this.next += 1;
    if (!step) throw new Error('FakeProvider: no scripted step left');
    if (Array.isArray(step)) yield* step;
    else yield* step(request, signal ?? new AbortController().signal);
  }

  modelInfo(model: string): ModelInfo {
    return {
      model,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      supportsThinking: true,
      supportsImages: true,
    };
  }
}
