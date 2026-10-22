import type {
  AssistantContent,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  ModelRoute,
  ToolDefinition,
  ToolUseBlock,
} from '@artemis/llm';
import { errorResult, type ToolContext, type ToolResult, type Toolset } from '@artemis/tools';

/**
 * Events of one loop run, in order. The agent-server maps them to
 * `ConversationEvent`s (SSE) and to storage writes.
 */
export type LoopEvent =
  | { type: 'step_start'; step: number }
  | { type: 'text_delta'; messageId: string; blockIndex: number; text: string }
  | { type: 'reasoning_delta'; messageId: string; blockIndex: number; text: string }
  | { type: 'tool_call'; messageId: string; toolCallId: string; name: string }
  /** The assistant message of a step is complete (persist it before tools run). */
  | { type: 'assistant_message'; messageId: string; message: LlmMessage & { role: 'assistant' }; response: LlmResponse }
  /** Completion order (calls of one step run concurrently); `tool_results_message` follows all of them. */
  | { type: 'tool_result'; toolCallId: string; name: string; input: unknown; result: ToolResult; durationMs: number }
  /** Tool results of a step, as the user message appended to the history. */
  | { type: 'tool_results_message'; messageId: string; message: LlmMessage & { role: 'user' } }
  | { type: 'loop_end'; outcome: LoopOutcome };

export interface LoopOutcome {
  status: 'completed' | 'cancelled' | 'failed' | 'max_steps';
  /** Concatenated final assistant text (last step). */
  text: string;
  error?: string;
  usage: LlmUsage & { steps: number; lastContextTokens: number };
  model: string;
}

export interface LoopInput<C extends ToolContext> {
  route: ModelRoute;
  /** Frozen system prompt and tool definitions (from the prompt snapshot). */
  system: string;
  toolDefinitions: ReturnType<Toolset<C>['definitions']>;
  toolset: Toolset<C>;
  /** Stored transcript (replayed verbatim) followed by the new user message(s). */
  messages: LlmMessage[];
  /**
   * Builds the per-call tool context. Its `signal` must be `signal` below (the
   * loop aborts running tools through it).
   */
  toolContext: (call: ToolUseBlock) => C;
  signal: AbortSignal;
  /** Safety bound on model steps (default 64). */
  maxSteps?: number;
  /** Message ids are allocated by the caller so streamed deltas and stored rows share them. */
  newMessageId: () => string;
}

const DEFAULT_MAX_STEPS = 64;
const CANCELLED_TEXT = 'Cancelled by the user';

const FAILURE_TEXT = {
  refusal: 'The model refused the request',
  max_tokens: 'The response reached the max_tokens limit',
  error: 'The model call failed',
} as const;

/**
 * Generic agent loop: stream a model step, persist-then-execute its tool calls
 * (concurrently, results returned in one user message in call order), repeat
 * until a step ends without tool calls, the signal aborts, or `maxSteps`.
 *
 * Cancellation: abort stops the stream (partial assistant message kept with
 * `stopReason: 'aborted'`), aborts running tools through their context signal,
 * and appends synthetic `isError` tool results ("Cancelled by the user") for
 * every tool_use without a result, so the stored history stays valid.
 * `max_tokens` / `refusal` / `error` stop reasons end the loop without running
 * tools (their tool_uses get synthetic error results). A step that would exceed
 * `maxSteps` does not run its tools either.
 */
export class AgentLoop {
  run<C extends ToolContext>(input: LoopInput<C>): AsyncIterable<LoopEvent> {
    return new LoopRun(input).events();
  }
}

type StepResult =
  | { kind: 'response'; response: LlmResponse }
  | { kind: 'cancelled' }
  | { kind: 'error'; error: string };

interface CallResult {
  index: number;
  result: ToolResult;
  durationMs: number;
}

/** State of one `AgentLoop.run` call. */
class LoopRun<C extends ToolContext> {
  private readonly messages: LlmMessage[];
  private readonly maxSteps: number;
  private readonly usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  private steps = 0;
  private lastContextTokens = 0;
  private lastText = '';
  private model: string;

  constructor(private readonly input: LoopInput<C>) {
    this.messages = [...input.messages];
    this.maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
    this.model = input.route.model;
  }

  async *events(): AsyncGenerator<LoopEvent> {
    let outcome: LoopOutcome;
    try {
      outcome = yield* this.drive();
    } catch (error) {
      outcome = this.outcome('failed', errorMessage(error));
    }
    yield { type: 'loop_end', outcome };
  }

  private async *drive(): AsyncGenerator<LoopEvent, LoopOutcome> {
    const { signal, newMessageId } = this.input;

    while (true) {
      if (signal.aborted) return this.outcome('cancelled');

      this.steps += 1;
      yield { type: 'step_start', step: this.steps };

      const messageId = newMessageId();
      const step = yield* this.streamStep(messageId);
      if (step.kind === 'cancelled') return this.outcome('cancelled');
      if (step.kind === 'error') return this.outcome(signal.aborted ? 'cancelled' : 'failed', step.error);

      const { response } = step;
      const message: LlmMessage & { role: 'assistant' } = { role: 'assistant', content: response.content };
      this.messages.push(message);
      this.record(response);
      yield { type: 'assistant_message', messageId, message, response };

      const calls = response.content.filter(isToolUse);
      const stop = response.stopReason;

      if (stop === 'aborted' || signal.aborted) {
        yield* this.runCalls(calls, CANCELLED_TEXT);
        return this.outcome('cancelled');
      }
      if (stop === 'refusal' || stop === 'max_tokens' || stop === 'error') {
        const error = FAILURE_TEXT[stop];
        yield* this.runCalls(calls, `Not run: ${error}`);
        return this.outcome('failed', error);
      }
      if (calls.length === 0) {
        if (stop !== 'pause_turn') return this.outcome('completed');
        // Server-side tool loop paused: continue with the same history.
        if (this.steps >= this.maxSteps) return this.outcome('max_steps');
        continue;
      }
      if (this.steps >= this.maxSteps) {
        yield* this.runCalls(calls, 'Not run: the step limit was reached');
        return this.outcome('max_steps');
      }

      yield* this.runCalls(calls);
      if (signal.aborted) return this.outcome('cancelled');
    }
  }

  /** Streams one model call; deltas are forwarded, the final message is returned. */
  private async *streamStep(messageId: string): AsyncGenerator<LoopEvent, StepResult> {
    const { route, signal } = this.input;
    let response: LlmResponse | undefined;
    try {
      for await (const event of route.provider.stream(this.request(), signal)) {
        switch (event.type) {
          case 'text_delta':
            yield { type: 'text_delta', messageId, blockIndex: event.index, text: event.text };
            break;
          case 'reasoning_delta':
            yield { type: 'reasoning_delta', messageId, blockIndex: event.index, text: event.text };
            break;
          case 'block_start':
            if (event.block === 'tool_use' && event.toolUseId) {
              yield { type: 'tool_call', messageId, toolCallId: event.toolUseId, name: event.toolName ?? '' };
            }
            break;
          case 'message_end':
            response = event.message;
            break;
          default:
            break;
        }
      }
    } catch (error) {
      return signal.aborted ? { kind: 'cancelled' } : { kind: 'error', error: errorMessage(error) };
    }
    if (response) return { kind: 'response', response };
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'error', error: 'The provider ended without a message' };
  }

  /**
   * Runs (or, with `skipReason`, synthesizes results for) the calls of one step
   * and appends one user message with their results in call order.
   */
  private async *runCalls(calls: ToolUseBlock[], skipReason?: string): AsyncGenerator<LoopEvent, void> {
    const completions = new CompletionQueue<CallResult>();
    calls.forEach((call, index) => {
      void this.invoke(call, skipReason).then(({ result, durationMs }) => completions.push({ index, result, durationMs }));
    });

    const results: ToolResult[] = [];
    for (let done = 0; done < calls.length; done += 1) {
      const { index, result, durationMs } = await completions.take();
      const call = calls[index];
      if (!call) throw new Error(`Unknown tool call index ${index}`);
      results[index] = result;
      yield { type: 'tool_result', toolCallId: call.id, name: call.name, input: call.input, result, durationMs };
    }

    if (calls.length === 0) return;
    const content = calls.map((call, index) => {
      const result = results[index] ?? errorResult('No result');
      return { type: 'tool_result' as const, toolUseId: call.id, content: result.content, isError: result.isError };
    });
    const message: LlmMessage & { role: 'user' } = { role: 'user', content };
    this.messages.push(message);
    yield { type: 'tool_results_message', messageId: this.input.newMessageId(), message };
  }

  private async invoke(call: ToolUseBlock, skipReason?: string): Promise<{ result: ToolResult; durationMs: number }> {
    const started = performance.now();
    const result = await this.execute(call, skipReason);
    return { result, durationMs: Math.round(performance.now() - started) };
  }

  private async execute(call: ToolUseBlock, skipReason?: string): Promise<ToolResult> {
    const { signal } = this.input;
    if (skipReason !== undefined) return errorResult(skipReason);
    if (signal.aborted) return errorResult(CANCELLED_TEXT);
    return untilAborted(this.runTool(call), signal, () => errorResult(CANCELLED_TEXT));
  }

  /** Never rejects: unexpected throws become error results. */
  private async runTool(call: ToolUseBlock): Promise<ToolResult> {
    try {
      const context = this.input.toolContext(call);
      return await this.input.toolset.execute(call.name, call.input, context);
    } catch (error) {
      return errorResult(errorMessage(error));
    }
  }

  private request(): LlmRequest {
    const { route, system, toolDefinitions } = this.input;
    const tools: ToolDefinition[] = toolDefinitions;
    return {
      model: route.model,
      system,
      tools,
      messages: [...this.messages],
      maxTokens: route.maxTokens,
      thinking: route.thinking,
      showReasoning: route.showReasoning,
      effort: route.effort,
      cache: route.cache,
      compaction: route.compaction,
      parallelToolCalls: true,
    };
  }

  private record(response: LlmResponse): void {
    const { usage } = response;
    this.model = response.model;
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.usage.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.usage.reasoningTokens += usage.reasoningTokens ?? 0;
    this.lastContextTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    this.lastText = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
  }

  private outcome(status: LoopOutcome['status'], error?: string): LoopOutcome {
    return {
      status,
      text: this.lastText,
      ...(error === undefined ? {} : { error }),
      usage: { ...this.usage, steps: this.steps, lastContextTokens: this.lastContextTokens },
      model: this.model,
    };
  }
}

function isToolUse(block: AssistantContent): block is ToolUseBlock {
  return block.type === 'tool_use';
}

/** Resolves with `onAbort()` as soon as `signal` aborts, otherwise with `work`. */
function untilAborted(work: Promise<ToolResult>, signal: AbortSignal, onAbort: () => ToolResult): Promise<ToolResult> {
  return new Promise((resolve) => {
    const aborted = () => resolve(onAbort());
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
    void work.then((result) => {
      signal.removeEventListener('abort', aborted);
      resolve(result);
    });
  });
}

/** Completions in arrival order, consumed one at a time. */
class CompletionQueue<T> {
  private readonly ready: T[] = [];
  private readonly waiting: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter(item);
    else this.ready.push(item);
  }

  take(): Promise<T> {
    if (this.ready.length > 0) return Promise.resolve(this.ready.shift() as T);
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
