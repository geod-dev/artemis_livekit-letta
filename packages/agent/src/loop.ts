import { notImplemented } from '@artemis/core';
import type { LlmMessage, LlmResponse, LlmUsage, ModelRoute, ToolUseBlock } from '@artemis/llm';
import type { ToolContext, ToolResult, Toolset } from '@artemis/tools';

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
  /** Builds the per-call tool context. */
  toolContext: (call: ToolUseBlock) => C;
  signal: AbortSignal;
  /** Safety bound on model steps (default 64). */
  maxSteps?: number;
  /** Message ids are allocated by the caller so streamed deltas and stored rows share them. */
  newMessageId: () => string;
}

/**
 * Generic agent loop: stream a model step, persist-then-execute its tool calls
 * (concurrently, results returned in one user message in call order), repeat
 * until a step ends without tool calls, the signal aborts, or `maxSteps`.
 *
 * Cancellation: abort stops the stream (partial assistant message kept with
 * `stopReason: 'aborted'`), aborts running tools through their context signal,
 * and appends synthetic `isError` tool results ("Cancelled by the user") for
 * every tool_use without a result, so the stored history stays valid.
 * `max_tokens` / `refusal` stop reasons end the loop without running tools.
 */
export class AgentLoop {
  run<C extends ToolContext>(_input: LoopInput<C>): AsyncIterable<LoopEvent> {
    return notImplemented('AgentLoop.run');
  }
}
