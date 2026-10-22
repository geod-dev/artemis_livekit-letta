import type * as Chat from 'openai/resources/chat/completions';
import type { ResponseAccumulator } from '../accumulator.ts';
import type { StopReason } from '../types.ts';

/** Chunk delta plus the non-standard reasoning fields some hosts (GLM on Telnyx) send. */
interface ReasoningDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Chat.ChatCompletionChunk.Choice.Delta.ToolCall[];
}

/**
 * Feeds Chat Completions chunks into a `ResponseAccumulator`. Blocks are opened
 * lazily: text and reasoning on their first delta, one tool block per tool call index.
 */
export class OpenAiStreamMapper {
  /** Set from `finish_reason`; undefined if the stream ended without one. */
  stopReason: StopReason | undefined;

  private started = false;
  private sawToolCalls = false;
  private lastBlock: { kind: 'text' | 'reasoning'; index: number } | undefined;
  private readonly toolIndexes = new Map<number, number>();

  constructor(private readonly acc: ResponseAccumulator) {}

  apply(chunk: Chat.ChatCompletionChunk): void {
    if (!this.started) {
      this.started = true;
      this.acc.messageStart({ providerMessageId: chunk.id, model: chunk.model });
    }
    if (chunk.usage) this.readUsage(chunk.usage);

    const choice = chunk.choices[0];
    if (!choice) return;
    const delta = choice.delta as ReasoningDelta;

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) this.text('reasoning', reasoning);
    if (delta.content) this.text('text', delta.content);
    for (const toolCall of delta.tool_calls ?? []) this.toolCall(toolCall);

    if (choice.finish_reason) this.stopReason = mapFinishReason(choice.finish_reason, this.sawToolCalls);
  }

  private text(kind: 'text' | 'reasoning', value: string): void {
    if (this.lastBlock?.kind !== kind) {
      this.lastBlock = { kind, index: this.acc.startBlock(kind) };
    }
    if (kind === 'text') this.acc.text(this.lastBlock.index, value);
    else this.acc.reasoning(this.lastBlock.index, value);
  }

  private toolCall(toolCall: Chat.ChatCompletionChunk.Choice.Delta.ToolCall): void {
    this.sawToolCalls = true;
    let index = this.toolIndexes.get(toolCall.index);
    if (index === undefined) {
      index = this.acc.startBlock('tool_use', {
        toolUseId: toolCall.id ?? '',
        toolName: toolCall.function?.name ?? '',
      });
      this.toolIndexes.set(toolCall.index, index);
      this.lastBlock = undefined;
    }
    const args = toolCall.function?.arguments;
    if (args) this.acc.toolInput(index, args);
  }

  private readUsage(usage: Chat.ChatCompletionChunk['usage']): void {
    if (!usage) return;
    this.acc.usage({
      // prompt_tokens already includes cached tokens, matching LlmUsage.inputTokens.
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      ...(usage.prompt_tokens_details?.cached_tokens != null
        ? { cacheReadTokens: usage.prompt_tokens_details.cached_tokens }
        : {}),
      ...(usage.completion_tokens_details?.reasoning_tokens != null
        ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
        : {}),
    });
  }
}

function mapFinishReason(reason: string, sawToolCalls: boolean): StopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      // 'stop': a host can report tool calls under 'stop'.
      return sawToolCalls ? 'tool_use' : 'end_turn';
  }
}
