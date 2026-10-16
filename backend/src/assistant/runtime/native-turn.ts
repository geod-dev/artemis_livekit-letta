import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { ConversationEvent } from '../../chat-types';
import { mergeToolArguments } from './tool-arguments';

type NativeToolCall = { name: string; args: string };

/** Project turns Letta starts itself through the same SSE channel as app turns. */
export class NativeTurn {
  private turnId: string | null = null;
  private error: string | undefined;
  private calls = new Map<string, NativeToolCall>();

  constructor(
    private readonly emit: (event: ConversationEvent) => void,
    private readonly onTool?: (
      call: NativeToolCall | undefined,
      result: { content: unknown; isError?: boolean }
    ) => Promise<void>
  ) {}

  get active(): boolean {
    return this.turnId !== null;
  }

  async accept(message: SDKMessage): Promise<void> {
    // The SDK synthesizes result only for turns tracked by session.send().
    // Native notification turns still emit the authoritative idle loop status.
    if (message.type === 'loop_status') {
      if (message.status === 'WAITING_ON_INPUT' && this.active) {
        this.finish(!this.error, this.error);
        this.emit({ type: 'updates_changed' });
      }
      return;
    }
    if (message.type === 'result') {
      this.finish(message.success, message.errorCode ?? message.error ?? this.error);
      // Native notifications are persisted by Letta rather than encodeTurn.
      // Reconcile even when a mod cancelled a turn before it produced output.
      this.emit({ type: 'updates_changed' });
      return;
    }
    if (message.type === 'error') {
      this.error = message.message;
      return;
    }
    if (!['assistant', 'reasoning', 'tool_call', 'tool_result'].includes(message.type)) return;
    if (!this.turnId) {
      this.turnId = `native:${randomUUID()}`;
      this.emit({ type: 'turn_start', turnId: this.turnId, modality: 'text' });
    }
    const turnId = this.turnId;
    if (message.type === 'assistant' || message.type === 'reasoning') {
      if (message.content)
        this.emit({
          type: message.type === 'assistant' ? 'assistant_delta' : 'reasoning_delta',
          turnId,
          messageId: message.uuid,
          text: message.content,
        });
    } else if (message.type === 'tool_call') {
      const call = this.calls.get(message.toolCallId);
      this.calls.set(message.toolCallId, {
        name: message.toolName,
        args: mergeToolArguments(call?.args ?? '', message),
      });
      if (!call)
        this.emit({
          type: 'tool_call',
          turnId,
          toolCallId: message.toolCallId,
          name: message.toolName,
        });
    } else if (message.type === 'tool_result') {
      const call = this.calls.get(message.toolCallId);
      await this.onTool?.(call, message);
      this.emit({
        type: 'tool_result',
        turnId,
        toolCallId: message.toolCallId,
        args: call?.args || undefined,
        result: message.content.replace(/\[\[mcp-managed-artifacts:v1:[0-9a-f-]{36}\]\]/gi, ''),
        isError: message.isError,
      });
    }
  }

  finish(success: boolean, error?: string): void {
    if (this.turnId)
      this.emit({ type: 'turn_end', turnId: this.turnId, success, ...(error ? { error } : {}) });
    this.turnId = null;
    this.error = undefined;
    this.calls.clear();
  }
}
