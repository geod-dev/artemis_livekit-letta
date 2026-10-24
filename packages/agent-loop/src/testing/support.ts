import {
  LlmProvider,
  type AssistantContent,
  type LlmMessage,
  type LlmResponse,
  type LlmStreamEvent,
  type ModelRoute,
  type StopReason,
  type ToolDefinition,
  type ToolUseBlock,
} from '@artemis/llm';
import { errorResult, Toolset, type ToolContext, type ToolResult } from '@artemis/tools';
import type { LoopEvent, LoopInput } from '../loop.ts';

export { FakeProvider, type StreamScript } from '@artemis/llm/testing';

export const FAKE_USAGE = { inputTokens: 10, outputTokens: 5 };

/** A complete step: text block, then `message_end`. */
export function textStep(text: string, stopReason: StopReason = 'end_turn'): LlmStreamEvent[] {
  return messageEvents([{ type: 'text', text }], stopReason, [
    { type: 'text_delta', index: 0, text },
  ]);
}

/** A complete step with tool calls (one `tool_use` block each), optionally preceded by text. */
export function toolStep(
  calls: Array<{ id: string; name: string; input?: unknown }>,
  text = ''
): LlmStreamEvent[] {
  const toolBlocks: AssistantContent[] = calls.map((call) => ({
    type: 'tool_use',
    id: call.id,
    name: call.name,
    input: call.input ?? {},
  }));
  const content: AssistantContent[] = text ? [{ type: 'text', text }, ...toolBlocks] : toolBlocks;
  const deltas: LlmStreamEvent[] = [];
  let index = 0;
  if (text) {
    deltas.push({ type: 'text_delta', index, text });
    index += 1;
  }
  for (const call of calls) {
    deltas.push({
      type: 'block_start',
      index,
      block: 'tool_use',
      toolUseId: call.id,
      toolName: call.name,
    });
    deltas.push({ type: 'block_end', index });
    index += 1;
  }
  return messageEvents(content, 'tool_use', deltas);
}

/** `message_start`, the given deltas, and `message_end` with the given content. */
export function messageEvents(
  content: AssistantContent[],
  stopReason: StopReason,
  deltas: LlmStreamEvent[] = []
): LlmStreamEvent[] {
  return [
    { type: 'message_start', model: 'fake-model', providerMessageId: 'provider-msg' },
    ...deltas,
    { type: 'message_end', message: response(content, stopReason) },
  ];
}

export function response(content: AssistantContent[], stopReason: StopReason): LlmResponse {
  return {
    providerMessageId: 'provider-msg',
    model: 'fake-model',
    content,
    stopReason,
    usage: { ...FAKE_USAGE },
    timings: { startedAt: new Date(0).toISOString(), durationMs: 1 },
  };
}

export type Handler = (input: unknown, context: ToolContext) => Promise<ToolResult> | ToolResult;

/**
 * `Toolset` with scripted handlers. Like the real `Toolset`, unknown names become
 * error results; handler throws propagate (the loop must turn them into results).
 */
export class FakeToolset extends Toolset<ToolContext> {
  readonly executed: string[] = [];

  constructor(private readonly handlers: Record<string, Handler>) {
    super([]);
  }

  override definitions(): ToolDefinition[] {
    return Object.keys(this.handlers).map((name) => ({
      name,
      description: `${name} tool`,
      inputSchema: { type: 'object' },
    }));
  }

  override async execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const handler = this.handlers[name];
    if (!handler) return errorResult(`Unknown tool: ${name}`);
    this.executed.push(name);
    return handler(input, context);
  }
}

export function fakeRoute(provider: LlmProvider, overrides: Partial<ModelRoute> = {}): ModelRoute {
  return {
    provider,
    model: 'fake-model',
    thinking: 'adaptive',
    effort: 'medium',
    maxTokens: 1000,
    showReasoning: false,
    cache: false,
    compaction: false,
    ...overrides,
  };
}

export interface InputOptions {
  provider: LlmProvider;
  toolset: Toolset<ToolContext>;
  signal: AbortSignal;
  messages?: LlmMessage[];
  maxSteps?: number;
}

export function loopInput(options: InputOptions): LoopInput<ToolContext> {
  let counter = 0;
  return {
    route: fakeRoute(options.provider),
    system: 'system prompt',
    toolDefinitions: options.toolset.definitions(),
    toolset: options.toolset,
    messages: options.messages ?? [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    toolContext: (call: ToolUseBlock) =>
      ({
        conversationId: 'conv_1',
        taskId: null,
        turnId: 'turn_1',
        toolCallId: call.id,
        signal: options.signal,
        policy: 'interactive',
        workspace: undefined as never,
        access: undefined as never,
        logger: undefined as never,
      }) as ToolContext,
    signal: options.signal,
    maxSteps: options.maxSteps,
    newMessageId: () => {
      counter += 1;
      return `msg_${counter}`;
    },
  };
}

export async function collect(events: AsyncIterable<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
