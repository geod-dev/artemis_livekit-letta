import type * as Messages from '@anthropic-ai/sdk/resources/messages';
import type * as BetaMessages from '@anthropic-ai/sdk/resources/beta/messages';
import type { ResponseAccumulator } from '../accumulator.ts';
import type { StopReason } from '../types.ts';

/** Raw events from `messages.stream` (plain) or `beta.messages.stream` (compaction). */
export type AnthropicRawEvent =
  | Messages.RawMessageStreamEvent
  | BetaMessages.BetaRawMessageStreamEvent;

type ContentBlockStart =
  | Messages.RawContentBlockStartEvent['content_block']
  | BetaMessages.BetaRawContentBlockStartEvent['content_block'];
type ContentBlockDelta = Messages.RawContentBlockDelta | BetaMessages.BetaRawContentBlockDelta;

interface UsageFields {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface CompactionDraft {
  type: 'compaction';
  content: string | null;
  encrypted_content: string | null;
  signature?: string | null;
  tool_changes?: unknown;
}

/** SDK content-block index -> canonical index, or `IGNORED` for blocks we do not map. */
const IGNORED = -1;

/**
 * Feeds raw Anthropic stream events into a `ResponseAccumulator`. Kept separate from
 * the provider so the mapping is testable with recorded event sequences.
 */
export class AnthropicStreamMapper {
  /** Set by `message_delta`; undefined if the stream ended without one. */
  stopReason: StopReason | undefined;

  private readonly indexes = new Map<number, number>();
  private readonly compactions = new Map<number, CompactionDraft>();
  private inputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private outputTokens = 0;

  constructor(private readonly acc: ResponseAccumulator) {}

  apply(event: AnthropicRawEvent): void {
    switch (event.type) {
      case 'message_start':
        this.acc.messageStart({ providerMessageId: event.message.id, model: event.message.model });
        this.readUsage(event.message.usage);
        return;
      case 'content_block_start':
        this.blockStart(event.index, event.content_block);
        return;
      case 'content_block_delta':
        this.blockDelta(event.index, event.delta);
        return;
      case 'content_block_stop':
        this.blockStop(event.index);
        return;
      case 'message_delta':
        if (event.delta.stop_reason) this.stopReason = mapStopReason(event.delta.stop_reason);
        this.readUsage(event.usage);
        return;
      case 'message_stop':
        return;
    }
  }

  private blockStart(sdkIndex: number, block: ContentBlockStart): void {
    switch (block.type) {
      case 'text': {
        const index = this.acc.startBlock('text');
        this.indexes.set(sdkIndex, index);
        if (block.text) this.acc.text(index, block.text);
        return;
      }
      case 'thinking': {
        const index = this.acc.startBlock('reasoning');
        this.indexes.set(sdkIndex, index);
        if (block.thinking) this.acc.reasoning(index, block.thinking);
        if (block.signature) this.acc.reasoningSignature(index, block.signature);
        return;
      }
      case 'redacted_thinking': {
        const index = this.acc.startBlock('reasoning');
        this.indexes.set(sdkIndex, index);
        this.acc.redactedReasoning(index, block.data);
        return;
      }
      case 'tool_use': {
        const index = this.acc.startBlock('tool_use', { toolUseId: block.id, toolName: block.name });
        this.indexes.set(sdkIndex, index);
        return;
      }
      case 'compaction': {
        const index = this.acc.startBlock('provider');
        this.indexes.set(sdkIndex, index);
        this.compactions.set(sdkIndex, {
          type: 'compaction',
          content: block.content ?? null,
          encrypted_content: block.encrypted_content ?? null,
          ...(block.signature !== undefined ? { signature: block.signature } : {}),
          ...(block.tool_changes !== undefined ? { tool_changes: block.tool_changes } : {}),
        });
        return;
      }
      default:
        // Server tools, search results, etc. are not enabled by this package.
        this.indexes.set(sdkIndex, IGNORED);
    }
  }

  private blockDelta(sdkIndex: number, delta: ContentBlockDelta): void {
    const index = this.indexes.get(sdkIndex);
    if (index === undefined || index === IGNORED) return;
    switch (delta.type) {
      case 'text_delta':
        this.acc.text(index, delta.text);
        return;
      case 'thinking_delta':
        this.acc.reasoning(index, delta.thinking);
        return;
      case 'signature_delta':
        this.acc.reasoningSignature(index, delta.signature);
        return;
      case 'input_json_delta':
        this.acc.toolInput(index, delta.partial_json);
        return;
      case 'compaction_delta': {
        const draft = this.compactions.get(sdkIndex);
        if (!draft) return;
        if (delta.content !== null && delta.content !== undefined) {
          draft.content = (draft.content ?? '') + delta.content;
        }
        if (delta.encrypted_content !== null && delta.encrypted_content !== undefined) {
          draft.encrypted_content = delta.encrypted_content;
        }
        return;
      }
      default:
        // citations_delta: not used.
        return;
    }
  }

  private blockStop(sdkIndex: number): void {
    const index = this.indexes.get(sdkIndex);
    if (index === undefined || index === IGNORED) return;
    const draft = this.compactions.get(sdkIndex);
    // Compaction blocks are round-tripped verbatim, so they are stored whole.
    if (draft) this.acc.providerBlock(index, 'anthropic', draft);
    this.acc.closeBlock(index);
  }

  private readUsage(usage: UsageFields | undefined): void {
    if (!usage) return;
    if (usage.input_tokens != null) this.inputTokens = usage.input_tokens;
    if (usage.cache_read_input_tokens != null) this.cacheReadTokens = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens != null) this.cacheWriteTokens = usage.cache_creation_input_tokens;
    if (usage.output_tokens != null) this.outputTokens = usage.output_tokens;
    this.acc.usage({
      // Anthropic reports uncached input separately from cache reads and writes.
      inputTokens: this.inputTokens + this.cacheReadTokens + this.cacheWriteTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
    });
  }
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'pause_turn':
      return 'pause_turn';
    case 'refusal':
      return 'refusal';
    default:
      // end_turn, stop_sequence
      return 'end_turn';
  }
}
