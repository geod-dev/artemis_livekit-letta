import type { LoopEvent, LoopOutcome } from '@artemis/agent';
import type { Clock } from '@artemis/core';
import type { ConversationEvent } from '@artemis/contracts/chat-types';
import type { ToolResult } from '@artemis/tools';
import type { Storage, ToolCallStatus } from '@artemis/storage';
import type { CallStateFilter } from '../turns/envelope.ts';

/** Drives an `AgentLoop` run: `handle` is awaited for every event before the loop continues. */
export async function drainLoop(events: AsyncIterable<LoopEvent>, handle: (event: LoopEvent) => Promise<void>): Promise<LoopOutcome> {
  for await (const event of events) {
    if (event.type === 'loop_end') return event.outcome;
    await handle(event);
  }
  throw new Error('The agent loop ended without an outcome');
}

interface LoopScope {
  conversationId: string;
  /** Null for the conversation transcript (main agent). */
  taskId: string | null;
  /** Null for subagent tasks, which are not tied to a turn. */
  turnId: string | null;
  provider: string;
}

interface LoopPersistenceOptions {
  scope: LoopScope;
  storage: Storage;
  clock: Clock;
  signal: AbortSignal;
  /** Live events to the conversation (main agent turns only). */
  publish?: (event: ConversationEvent) => void;
  /** Voice turns: marker filter and the spoken-text sink. */
  voice?: { filter: CallStateFilter; onText?: (text: string) => void };
}

interface AssistantLike {
  content: unknown[];
}

interface ResponseLike {
  model: string;
  providerMessageId?: string;
  stopReason: string;
  usage: unknown;
  timings: unknown;
}

/**
 * Persists every loop event as it happens (persist-before-execute: an assistant
 * message and its tool calls are stored before their tools run) and publishes
 * the live events of a conversation turn. Shared by main agents and subagents;
 * subagents have no turn, so nothing is published for them.
 */
export class LoopPersistence {
  /** Content block of the latest voice text delta (see `assistantMessage`). */
  private spokenBlock = 0;

  constructor(private readonly options: LoopPersistenceOptions) {}

  async handle(event: LoopEvent): Promise<void> {
    switch (event.type) {
      case 'text_delta':
        return this.textDelta(event.messageId, event.blockIndex, event.text);
      case 'reasoning_delta':
        return this.publish({
          type: 'reasoning_delta',
          turnId: this.turnId(),
          messageId: `${event.messageId}:${event.blockIndex}`,
          text: event.text,
        });
      case 'tool_call':
        return this.publish({ type: 'tool_call', turnId: this.turnId(), toolCallId: event.toolCallId, name: event.name });
      case 'assistant_message':
        return this.assistantMessage(event.messageId, event.message, event.response);
      case 'tool_result':
        return this.toolResult(event.toolCallId, event.input, event.result);
      case 'tool_results_message':
        return this.toolResultsMessage(event.messageId, event.message.content);
      default:
        return;
    }
  }

  private textDelta(messageId: string, blockIndex: number, text: string): void {
    const voice = this.options.voice;
    if (!voice) {
      this.publish({ type: 'assistant_delta', turnId: this.turnId(), messageId: `${messageId}:${blockIndex}`, text });
      return;
    }
    this.spokenBlock = blockIndex;
    this.emitSpoken(messageId, blockIndex, voice.filter.push(text));
  }

  private async assistantMessage(messageId: string, message: AssistantLike, response: ResponseLike): Promise<void> {
    const { scope, storage, clock } = this.options;
    // Held-back text belongs to the most recent text delta, which is the block it was streamed in.
    const rest = this.options.voice?.filter.flush() ?? '';
    this.emitSpoken(messageId, this.spokenBlock, rest);
    await storage.messages.append({
      id: messageId,
      conversationId: scope.conversationId,
      taskId: scope.taskId,
      turnId: scope.turnId,
      role: 'assistant',
      content: message.content,
      envelope: null,
      provider: scope.provider,
      model: response.model,
      providerMessageId: response.providerMessageId ?? null,
      stopReason: response.stopReason,
      usage: response.usage,
      timings: response.timings,
    });
    const startedAt = new Date(clock.now()).toISOString();
    for (const block of message.content) {
      const call = block as { type?: string; id?: string; name?: string; input?: unknown };
      if (call.type !== 'tool_use' || !call.id || !call.name) continue;
      await storage.toolCalls.start({
        id: call.id,
        conversationId: scope.conversationId,
        taskId: scope.taskId,
        turnId: scope.turnId,
        assistantMessageId: messageId,
        name: call.name,
        input: call.input ?? {},
        startedAt,
      });
    }
  }

  private async toolResult(toolCallId: string, input: unknown, result: ToolResult): Promise<void> {
    const { storage, clock, signal } = this.options;
    const text = textOf(result);
    const status: ToolCallStatus = result.backgrounded
      ? 'backgrounded'
      : result.isError
        ? signal.aborted
          ? 'cancelled'
          : 'failed'
        : 'completed';
    await storage.toolCalls.finish(toolCallId, {
      status,
      resultText: text,
      isError: result.isError,
      display: result.display ?? null,
      taskRef: result.task ?? null,
      endedAt: new Date(clock.now()).toISOString(),
    });
    this.publish({
      type: 'tool_result',
      turnId: this.turnId(),
      toolCallId,
      args: JSON.stringify(input ?? {}),
      result: text,
      isError: result.isError,
      ...(result.display ? { display: result.display } : {}),
      ...(result.task ? { task: result.task } : {}),
    });
  }

  private async toolResultsMessage(messageId: string, content: unknown[]): Promise<void> {
    const { scope, storage } = this.options;
    await storage.messages.append({
      id: messageId,
      conversationId: scope.conversationId,
      taskId: scope.taskId,
      turnId: scope.turnId,
      role: 'user',
      content,
      envelope: null,
      provider: null,
      model: null,
      providerMessageId: null,
      stopReason: null,
      usage: null,
      timings: null,
    });
  }

  private emitSpoken(messageId: string, blockIndex: number, text: string): void {
    if (!text) return;
    this.options.voice?.onText?.(text);
    this.publish({ type: 'assistant_delta', turnId: this.turnId(), messageId: `${messageId}:${blockIndex}`, text });
  }

  private turnId(): string {
    return this.options.scope.turnId ?? '';
  }

  private publish(event: ConversationEvent): void {
    if (this.options.scope.turnId) this.options.publish?.(event);
  }
}

/** The model-facing text of a tool result (images are not text). */
export function textOf(result: ToolResult): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}
