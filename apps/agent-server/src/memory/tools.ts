import { type Clock, type Logger, systemClock, uuid } from '@artemis/core';
import { type AnyTool, Tool, TOOL_NAMES, errorResult, textResult, type ToolResult } from '@artemis/tools';
import type { TextEffort } from '@artemis/contracts/chat-types';
import { type MemoryStore, type RecallBudget, recallBudget, renderRecalledMemories } from '@artemis/memory';
import type { AgentServerConfig } from '../config.ts';
import type { AgentToolContext } from '../tools/index.ts';
import { runWithTimeout } from './abort.ts';

/**
 * Memory tools of the agent (architecture.md#5), on the `MemoryStore`
 * abstraction only. Appended to the agent toolset in `TOOL_NAMES` order.
 * - `memory_search {query, budget?}`: on-demand recall, rendered like the
 *   automatic `<recalled-memories>` block. Default budget = `recallBudget` of
 *   the current turn (voice -> low; text effort low/medium -> mid; high+ -> high).
 * - `memory_remember {content, context?}`: immediate retain of one note
 *   (`document_id = memory-note:<uuid>`, metadata `source: 'tool'`).
 */

/** Tool context plus the effort of the turn, when the caller knows it. */
export type MemoryToolContext = AgentToolContext & { effort?: TextEffort | null };

interface MemoryToolsOptions {
  store: MemoryStore;
  config: Pick<AgentServerConfig, 'assistant' | 'memory'>;
  clock?: Clock;
  logger?: Logger;
}

/** Acceptance of a note by the memory store (processing is asynchronous). */
const REMEMBER_TIMEOUT_MS = 15_000;

export function createMemoryTools(options: MemoryToolsOptions): AnyTool<AgentToolContext>[] {
  return [new MemorySearchTool(options), new MemoryRememberTool(options)];
}

interface SearchInput {
  query: string;
  budget?: RecallBudget;
}

class MemorySearchTool extends Tool<SearchInput, MemoryToolContext> {
  readonly name = TOOL_NAMES.memorySearch;
  readonly description =
    'Search long-term memory of the user (past conversations and notes). Use it when an answer may depend on something said or decided before. Returns the matching memories.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 2000, description: 'What to look for, in natural language.' },
      budget: {
        type: 'string',
        enum: ['low', 'mid', 'high'],
        description: 'How much to retrieve. Defaults to the budget of the current turn.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  };
  override readonly readOnly = true;

  constructor(private readonly options: MemoryToolsOptions) {
    super();
  }

  async execute(input: SearchInput, context: MemoryToolContext): Promise<ToolResult> {
    const { memory } = this.options.config;
    if (!memory.enabled) return errorResult('Memory is disabled on this server.');
    const budget =
      input.budget ??
      recallBudget({ modality: context.mode === 'text' ? 'text' : 'voice', effort: context.effort ?? null });
    const timeoutMs = context.mode === 'text' ? memory.recallTimeoutMs.text : memory.recallTimeoutMs.voice;
    try {
      const result = await runWithTimeout(
        { clock: this.clock(), timeoutMs, parent: context.signal },
        (signal) =>
          this.options.store.recall(
            {
              query: input.query,
              budget,
              maxTokens: memory.recallMaxTokens[budget],
              queryTimestamp: new Date(this.clock().now()).toISOString(),
            },
            signal
          )
      );
      if (result.facts.length === 0) return textResult(`No memories match "${input.query}".`);
      return textResult(renderRecalledMemories(result.facts));
    } catch (error) {
      return errorResult(`Memory search failed: ${messageOf(error)}`);
    }
  }

  private clock(): Clock {
    return this.options.clock ?? systemClock;
  }
}

interface RememberInput {
  content: string;
  context?: string;
}

class MemoryRememberTool extends Tool<RememberInput, MemoryToolContext> {
  readonly name = TOOL_NAMES.memoryRemember;
  readonly description =
    'Save a note to long-term memory of the user, for something worth recalling in future conversations. Write it as a self-contained statement.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      content: { type: 'string', minLength: 1, maxLength: 4000, description: 'The note, self-contained.' },
      context: { type: 'string', maxLength: 500, description: 'Why it matters or where it comes from.' },
    },
    required: ['content'],
    additionalProperties: false,
  };

  constructor(private readonly options: MemoryToolsOptions) {
    super();
  }

  async execute(input: RememberInput, context: MemoryToolContext): Promise<ToolResult> {
    const { memory, assistant } = this.options.config;
    if (!memory.enabled) return errorResult('Memory is disabled on this server.');
    const clock = this.options.clock ?? systemClock;
    const id = uuid();
    const now = new Date(clock.now()).toISOString();
    try {
      await runWithTimeout({ clock, timeoutMs: REMEMBER_TIMEOUT_MS, parent: context.signal }, (signal) =>
        this.options.store.retain(
          {
            documentId: `memory-note:${id}`,
            operationId: id,
            turns: [{ speaker: assistant.name, at: now, text: input.content }],
            context: input.context ?? 'A note the assistant saved to memory during a conversation with the user.',
            timestamp: now,
            metadata: { conversationId: context.conversationId, source: 'tool' },
          },
          signal
        )
      );
      return textResult(`Saved to memory (note ${id}).`);
    } catch (error) {
      this.options.logger?.warn('memory note not saved', { error: messageOf(error) });
      return errorResult(`Could not save the note: ${messageOf(error)}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
