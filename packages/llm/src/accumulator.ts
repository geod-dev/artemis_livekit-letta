import type {
  AssistantContent,
  LlmResponse,
  LlmStreamEvent,
  LlmUsage,
  StopReason,
} from './types.ts';

type BlockKind = 'text' | 'reasoning' | 'tool_use' | 'provider';

interface PendingBlock {
  kind: BlockKind;
  text: string;
  signature?: string;
  redacted?: string;
  toolUseId?: string;
  toolName?: string;
  toolJson: string;
  provider?: string;
  block?: unknown;
}

/**
 * Provider-neutral assembly of one model step. Provider adapters translate their
 * SDK events into these calls; the accumulator queues the canonical
 * `LlmStreamEvent`s (drain with `drain()`) and builds the final `LlmResponse`.
 *
 * Only one block is open at a time; opening a block closes the previous one.
 */
export class ResponseAccumulator {
  private readonly blocks: PendingBlock[] = [];
  private readonly queued: LlmStreamEvent[] = [];
  private readonly usageTotals: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  private open: number | undefined;
  private messageStarted = false;
  private providerMessageId: string | undefined;
  private model: string;
  private firstTokenMs: number | undefined;
  private readonly startedMs: number;
  private readonly startedAt: string;

  constructor(
    model: string,
    private readonly now: () => number = Date.now
  ) {
    this.model = model;
    this.startedMs = now();
    this.startedAt = new Date(this.startedMs).toISOString();
  }

  /** Emits `message_start` once; later calls only refresh the ids. */
  messageStart(info: { providerMessageId?: string; model?: string }): void {
    if (info.providerMessageId) this.providerMessageId = info.providerMessageId;
    if (info.model) this.model = info.model;
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.queued.push({
      type: 'message_start',
      providerMessageId: this.providerMessageId,
      model: this.model,
    });
  }

  /** Opens a block at the next index (closing the open one). Returns its index. */
  startBlock(kind: BlockKind, tool?: { toolUseId?: string; toolName?: string }): number {
    this.closeOpen();
    const index = this.blocks.length;
    this.blocks.push({
      kind,
      text: '',
      toolJson: '',
      toolUseId: tool?.toolUseId,
      toolName: tool?.toolName,
    });
    this.open = index;
    this.queued.push({
      type: 'block_start',
      index,
      block: kind,
      ...(kind === 'tool_use' ? { toolUseId: tool?.toolUseId, toolName: tool?.toolName } : {}),
    });
    return index;
  }

  text(index: number, text: string): void {
    this.expect(index, 'text').text += text;
    this.emitDelta({ type: 'text_delta', index, text });
  }

  reasoning(index: number, text: string): void {
    this.expect(index, 'reasoning').text += text;
    this.emitDelta({ type: 'reasoning_delta', index, text });
  }

  toolInput(index: number, partialJson: string): void {
    this.expect(index, 'tool_use').toolJson += partialJson;
    this.emitDelta({ type: 'tool_input_delta', index, partialJson });
  }

  /** Signature for replaying a reasoning block verbatim (Anthropic). */
  reasoningSignature(index: number, signature: string): void {
    this.expect(index, 'reasoning').signature = signature;
  }

  /** Encrypted reasoning with no readable text (Anthropic `redacted_thinking`). */
  redactedReasoning(index: number, redacted: string): void {
    this.expect(index, 'reasoning').redacted = redacted;
  }

  /** Opaque provider block, kept for exact replay. Set before the block closes. */
  providerBlock(index: number, provider: string, block: unknown): void {
    const pending = this.expect(index, 'provider');
    pending.provider = provider;
    pending.block = block;
  }

  closeBlock(index: number): void {
    if (this.open !== index) return;
    this.closeOpen();
  }

  /** Adds usage counters; each field overwrites the previous value when given. */
  usage(update: Partial<LlmUsage>): void {
    const totals = this.usageTotals;
    if (update.inputTokens !== undefined) totals.inputTokens = update.inputTokens;
    if (update.outputTokens !== undefined) totals.outputTokens = update.outputTokens;
    if (update.cacheReadTokens !== undefined) totals.cacheReadTokens = update.cacheReadTokens;
    if (update.cacheWriteTokens !== undefined) totals.cacheWriteTokens = update.cacheWriteTokens;
    if (update.reasoningTokens !== undefined) totals.reasoningTokens = update.reasoningTokens;
  }

  /** Returns the queued events and clears the queue. */
  drain(): LlmStreamEvent[] {
    return this.queued.splice(0);
  }

  /** Closes the open block and queues the final `message_end`. */
  finish(stopReason: StopReason, error?: { code: string; message: string }): void {
    this.closeOpen();
    const message: LlmResponse = {
      ...(this.providerMessageId ? { providerMessageId: this.providerMessageId } : {}),
      model: this.model,
      content: this.content(),
      stopReason,
      usage: { ...this.usageTotals },
      timings: {
        startedAt: this.startedAt,
        ...(this.firstTokenMs !== undefined ? { firstTokenMs: this.firstTokenMs } : {}),
        durationMs: this.now() - this.startedMs,
      },
      ...(error ? { error } : {}),
    };
    this.queued.push({ type: 'message_end', message });
  }

  private content(): AssistantContent[] {
    const content: AssistantContent[] = [];
    for (const block of this.blocks) {
      switch (block.kind) {
        case 'text':
          // Kept even when empty: each block keeps the index it was streamed under (`startBlock`).
          // Replay drops empty text (Anthropic rejects it), see anthropic/request.ts.
          content.push({ type: 'text', text: block.text });
          break;
        case 'reasoning':
          content.push({
            type: 'reasoning',
            text: block.text,
            ...(block.signature !== undefined ? { signature: block.signature } : {}),
            ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
          });
          break;
        case 'tool_use':
          content.push({
            type: 'tool_use',
            id: block.toolUseId ?? '',
            name: block.toolName ?? '',
            input: parseToolInput(block.toolJson),
          });
          break;
        case 'provider':
          if (block.provider !== undefined) {
            content.push({ type: 'provider', provider: block.provider, block: block.block });
          }
          break;
      }
    }
    return content;
  }

  private emitDelta(event: LlmStreamEvent): void {
    this.firstTokenMs ??= this.now() - this.startedMs;
    this.queued.push(event);
  }

  private closeOpen(): void {
    if (this.open === undefined) return;
    this.queued.push({ type: 'block_end', index: this.open });
    this.open = undefined;
  }

  private expect(index: number, kind: BlockKind): PendingBlock {
    const block = this.blocks[index];
    if (!block || block.kind !== kind) {
      throw new Error(`Block ${index} is not an open ${kind} block`);
    }
    return block;
  }
}

/** Tool input as the model streamed it. Empty or malformed JSON (e.g. cut off) becomes `{}`. */
export function parseToolInput(json: string): unknown {
  if (!json.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
