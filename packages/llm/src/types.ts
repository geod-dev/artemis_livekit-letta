/**
 * Canonical, provider-neutral LLM types. Business logic only ever sees these;
 * provider implementations translate to and from their SDK shapes.
 *
 * Persistence rule: assistant messages are stored exactly as returned here
 * (including `reasoning.signature` and opaque `provider` blocks) and replayed
 * unchanged, so the provider's prompt-cache prefix and preserved-thinking
 * checks stay valid. History is append-only.
 */

export type JsonSchema = Record<string, unknown>;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Base64 data, no `data:` prefix. */
  data: string;
}

/** Model reasoning. `signature` / `redacted` must be replayed verbatim to the same provider. */
export interface ReasoningBlock {
  type: 'reasoning';
  text: string;
  signature?: string;
  /** Provider-encrypted reasoning with no readable text. */
  redacted?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: Array<TextBlock | ImageBlock>;
  isError: boolean;
}

/**
 * Opaque provider-specific block kept for exact replay (e.g. Anthropic
 * compaction blocks). A provider drops blocks whose `provider` is not its own.
 */
export interface ProviderBlock {
  type: 'provider';
  provider: string;
  block: unknown;
}

export type UserContent = TextBlock | ImageBlock | ToolResultBlock;
export type AssistantContent = TextBlock | ReasoningBlock | ToolUseBlock | ProviderBlock;

export type LlmMessage =
  | { role: 'user'; content: UserContent[] }
  | { role: 'assistant'; content: AssistantContent[] };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** `adaptive`: the model decides when and how much to think; `disabled`: never. */
export type ThinkingMode = 'adaptive' | 'disabled';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmRequest {
  model: string;
  /** Frozen system prompt (cached prefix). */
  system: string;
  /** Deterministic order: never re-sorted between requests of one conversation. */
  tools: ToolDefinition[];
  messages: LlmMessage[];
  maxTokens: number;
  thinking: ThinkingMode;
  /** Stream readable reasoning summaries when the provider supports it. */
  showReasoning?: boolean;
  effort?: Effort;
  /**
   * Prompt caching: providers with explicit breakpoints cache the tools+system
   * prefix and the history up to the last message.
   */
  cache?: boolean;
  /** Let the provider compact long histories server-side (returns `provider` blocks). */
  compaction?: boolean;
  parallelToolCalls?: boolean;
  /** Opaque per-provider extras (escape hatch). */
  providerOptions?: Record<string, unknown>;
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'pause_turn'
  | 'aborted'
  | 'error';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface LlmResponse {
  providerMessageId?: string;
  model: string;
  content: AssistantContent[];
  stopReason: StopReason;
  usage: LlmUsage;
  /** Measured by the provider adapter. */
  timings: { startedAt: string; firstTokenMs?: number; durationMs: number };
}

/** Streaming events, in order, for one model step. */
export type LlmStreamEvent =
  | { type: 'message_start'; providerMessageId?: string; model: string }
  | {
      type: 'block_start';
      index: number;
      block: 'text' | 'reasoning' | 'tool_use' | 'provider';
      toolUseId?: string;
      toolName?: string;
    }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'reasoning_delta'; index: number; text: string }
  | { type: 'tool_input_delta'; index: number; partialJson: string }
  | { type: 'block_end'; index: number }
  | { type: 'message_end'; message: LlmResponse };
