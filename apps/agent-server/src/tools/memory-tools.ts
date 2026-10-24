import { type Clock, type Logger, errorMessage, systemClock, uuid } from '@artemis/core';
import { type AnyTool, Tool, errorResult, textResult, type ToolResult } from '@artemis/tools';
import { TOOL_NAMES } from '@artemis/contracts/tool-names';
import { MEMORY_REMEMBER_INPUT_SCHEMA, MEMORY_SEARCH_INPUT_SCHEMA } from '@artemis/contracts/tool-schemas';
import { type MemoryStore, type RecallBudget, renderRecalledMemories } from '@artemis/memory';
import type { AgentServerConfig } from '../config.ts';
import type { MemoryCoordinator } from '../memory/coordinator.ts';
import { runWithTimeout } from '../util/async.ts';
import { isoAt } from '../util/time.ts';
import type { AgentToolContext } from './index.ts';

/**
 * Memory tools of the agent (docs/architecture.md, "Conversations memory and
 * background work"). Appended to the agent toolset in `TOOL_NAMES` order.
 * - `memory_search {query, budget?}`: on-demand recall through the coordinator's
 *   `recall`, so the budget, timeout, ledger and trace are the automatic ones.
 *   Rendered like the automatic `<recalled-memories>` block.
 * - `memory_remember {content, context?}`: immediate retain of one note
 *   (`document_id = memory-note:<uuid>`, metadata `source: 'tool'`) on the `MemoryStore`.
 */

interface MemoryToolsOptions {
  store: MemoryStore;
  coordinator: Pick<MemoryCoordinator, 'recall'>;
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

class MemorySearchTool extends Tool<SearchInput, AgentToolContext> {
  readonly name = TOOL_NAMES.memorySearch;
  readonly description =
    'Search long-term memory of the user (past conversations and notes). Use it when an answer may depend on something said or decided before. Returns the matching memories.';
  readonly inputSchema = MEMORY_SEARCH_INPUT_SCHEMA;
  override readonly readOnly = true;

  constructor(private readonly options: MemoryToolsOptions) {
    super();
  }

  async execute(input: SearchInput, context: AgentToolContext): Promise<ToolResult> {
    if (!this.options.config.memory.enabled) return errorResult('Memory is disabled on this server.');
    try {
      const facts = await this.options.coordinator.recall({
        conversationId: context.conversationId,
        turnId: context.turnId,
        modality: context.mode === 'text' ? 'text' : 'voice',
        effort: context.effort ?? null,
        query: input.query,
        ...(input.budget ? { budget: input.budget } : {}),
        signal: context.signal,
      });
      if (facts.length === 0) return textResult(`No memories match "${input.query}".`);
      return textResult(renderRecalledMemories(facts));
    } catch (error) {
      return errorResult(`Memory search failed: ${errorMessage(error)}`);
    }
  }
}

interface RememberInput {
  content: string;
  context?: string;
}

class MemoryRememberTool extends Tool<RememberInput, AgentToolContext> {
  readonly name = TOOL_NAMES.memoryRemember;
  readonly description =
    'Save a note to long-term memory of the user, for something worth recalling in future conversations. Write it as a self-contained statement.';
  readonly inputSchema = MEMORY_REMEMBER_INPUT_SCHEMA;

  constructor(private readonly options: MemoryToolsOptions) {
    super();
  }

  async execute(input: RememberInput, context: AgentToolContext): Promise<ToolResult> {
    const { memory, assistant } = this.options.config;
    if (!memory.enabled) return errorResult('Memory is disabled on this server.');
    const clock = this.options.clock ?? systemClock;
    const id = uuid();
    const now = isoAt(clock.now());
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
      this.options.logger?.warn('memory note not saved', { error: errorMessage(error) });
      return errorResult(`Could not save the note: ${errorMessage(error)}`);
    }
  }
}
