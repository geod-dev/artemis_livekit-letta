import { type Clock, type Logger, errorMessage, uuid } from '@artemis/core';
import type { RecalledMemory, Repositories, MemoryRetentionRecord, MessageRecord, RecallTrace, TurnRecord } from '@artemis/storage';
import {
  recallBudget,
  type MemoryFact,
  type MemoryStore,
  type RecallBudget,
  type RetainRequest,
  type TranscriptTurn,
} from '@artemis/memory';
import type { AgentServerConfig } from '../config.ts';
import { contentText } from '../util/content.ts';
import { runWithTimeout } from '../util/async.ts';
import { isoAt } from '../util/time.ts';
import { createMemoryOutbox, type MemoryOutbox } from './outbox.ts';

/** The app-state key of the conversation the user wrote to last (swapped on every accepted user message). */
export const LAST_ACTIVE_CONVERSATION_KEY = 'last_active_conversation_id';

/**
 * Applies the memory rules (docs/architecture.md, "Conversations, memory, and
 * background work"). Talks to long-term memory only through `MemoryStore`;
 * storage holds the outbox and the bookkeeping. Disabled memory is the no-op
 * store (`NoopMemoryStore`), so these rules run the same way with it.
 * - `conversationActivated(id)` on every accepted user message: swaps
 *   `last_active_conversation_id`; when it changed, flushes the previous
 *   conversation's unanalyzed completed turns.
 * - `recallFor(...)` before EVERY assistant answer: budget = `recallBudget`,
 *   timeout voice/text from config, memories already injected are dropped
 *   (`recall ledger`), the trace goes to `turns.recall`. Failures and timeouts
 *   give no memories; the turn proceeds.
 * - `turnCompleted(turn)`: when the conversation has `retainEvery` unanalyzed
 *   completed user turns, the turns up to the last of them are retained.
 * Retention records rows in the outbox (`memory_retentions`); the outbox pump
 * (`./outbox.ts`) submits them. The operation id is the row id, so retries are
 * idempotent. Memory failures never fail a turn.
 */
export interface MemoryCoordinator {
  conversationActivated(conversationId: string): Promise<void>;
  /** Automatic recall before an answer: never throws (a failure gives no memories). */
  recallFor(input: RecallInput): Promise<RecalledMemory[]>;
  /** The same recall policy for on-demand search: throws on failure or timeout. */
  recall(input: RecallInput): Promise<MemoryFact[]>;
  turnCompleted(turn: TurnRecord): Promise<void>;
  /** Retains every unanalyzed completed turn of the conversation (reason `switch` or `shutdown`). */
  flush(conversationId: string, reason: 'switch' | 'shutdown'): Promise<void>;
  /** Starts the outbox pump (periodic) and submits leftovers from a previous run. */
  start(): void;
  /** Stops the pump and waits for the submission in flight. */
  stop(): Promise<void>;
}

export interface RecallInput {
  conversationId: string;
  /** The turn the recall serves; null for a subagent task's search (no ledger, no trace). */
  turnId: string | null;
  modality: 'text' | 'voice';
  effort?: TurnRecord['effort'];
  /** The user's words (update turns: titles and first lines of reports). */
  query: string;
  /** Explicit budget (memory_search); default: `recallBudget` of the modality and effort. */
  budget?: RecallBudget;
  signal?: AbortSignal;
}

type MemoryCoordinatorStorage = Pick<
  Repositories,
  'turns' | 'messages' | 'appState' | 'memoryRetentions' | 'recallLedger'
>;

interface MemoryCoordinatorOptions {
  store: MemoryStore;
  storage: MemoryCoordinatorStorage;
  config: Pick<AgentServerConfig, 'assistant' | 'memory'>;
  clock: Clock;
  logger: Logger;
  /** Outbox pump period (default 5 s). */
  pumpIntervalMs?: number;
  /** Submission attempts before a retention is terminal (default 10). */
  maxAttempts?: number;
  /** Timeout of one retain call (default 30 s). */
  retainTimeoutMs?: number;
}

class StoreMemoryCoordinator implements MemoryCoordinator {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly outbox: MemoryOutbox;
  /** Per-conversation serialization of batch, flush and recall bookkeeping. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly options: MemoryCoordinatorOptions) {
    this.clock = options.clock;
    this.logger = options.logger;
    this.outbox = createMemoryOutbox({
      storage: options.storage,
      build: (row) => this.buildRetain(row),
      retain: (request, signal) => options.store.retain(request, signal),
      clock: options.clock,
      logger: options.logger,
      pumpIntervalMs: options.pumpIntervalMs,
      maxAttempts: options.maxAttempts,
      retainTimeoutMs: options.retainTimeoutMs,
    });
  }

  async conversationActivated(conversationId: string): Promise<void> {
    try {
      const previous = await this.options.storage.appState.swap<string>(LAST_ACTIVE_CONVERSATION_KEY, conversationId);
      if (typeof previous === 'string' && previous !== conversationId) {
        await this.flush(previous, 'switch');
      }
    } catch (error) {
      this.logger.error('activation bookkeeping failed', { conversationId, error: errorMessage(error) });
    }
  }

  async recallFor(input: RecallInput): Promise<RecalledMemory[]> {
    try {
      return (await this.recall(input)).map(toRecalledMemory);
    } catch (error) {
      this.logger.warn('recall skipped', { turnId: input.turnId, error: errorMessage(error) });
      return [];
    }
  }

  async recall(input: RecallInput): Promise<MemoryFact[]> {
    const { memory } = this.options.config;
    const budget = input.budget ?? recallBudget({ modality: input.modality, effort: input.effort });
    const timeoutMs = input.modality === 'voice' ? memory.recallTimeoutMs.voice : memory.recallTimeoutMs.text;
    const started = this.clock.now();
    const trace: RecallTrace = { budget, query: input.query, memoryIds: [], durationMs: 0 };
    try {
      const result = await runWithTimeout({ clock: this.clock, timeoutMs, parent: input.signal }, (signal) =>
        this.options.store.recall(
          {
            query: input.query,
            budget,
            maxTokens: memory.recallMaxTokens[budget],
            queryTimestamp: this.iso(),
          },
          signal
        )
      );
      const fresh = await this.freshFacts(input, result.facts);
      trace.memoryIds = fresh.map((fact) => fact.id);
      return fresh;
    } catch (error) {
      trace.error = errorMessage(error);
      throw error;
    } finally {
      trace.durationMs = this.clock.now() - started;
      if (input.turnId) {
        const turnId = input.turnId;
        await this.options.storage.turns.setRecall(turnId, trace).catch((error: unknown) => {
          this.logger.warn('recall trace not stored', { turnId, error: errorMessage(error) });
        });
      }
    }
  }

  /**
   * The facts this conversation has not been given yet; the fresh ones go to the
   * ledger under the turn. A search with no turn (a subagent task) is not deduplicated
   * and records nothing: the ledger and the trace belong to a turn.
   */
  private async freshFacts(input: RecallInput, facts: MemoryFact[]): Promise<MemoryFact[]> {
    if (!input.turnId) return facts;
    const { recallLedger } = this.options.storage;
    const injected = await recallLedger.injectedIds(input.conversationId);
    const fresh = facts.filter((fact) => !injected.has(fact.id));
    if (fresh.length > 0) await recallLedger.record(input.conversationId, input.turnId, fresh.map((fact) => fact.id));
    return fresh;
  }

  async turnCompleted(turn: TurnRecord): Promise<void> {
    await this.serial(turn.conversationId, async () => {
      const unanalyzed = await this.options.storage.turns.listUnanalyzed(turn.conversationId);
      const userTurns = unanalyzed.filter((row) => row.kind === 'user');
      const every = this.options.config.memory.retainEvery;
      const last = userTurns[every - 1];
      if (userTurns.length < every || !last) return;
      await this.retain(turn.conversationId, unanalyzed.filter((row) => row.seq <= last.seq), 'batch');
    }).catch((error: unknown) => this.logError('batch retention failed', turn.conversationId, error));
  }

  async flush(conversationId: string, reason: 'switch' | 'shutdown'): Promise<void> {
    await this.serial(conversationId, async () => {
      const turns = await this.options.storage.turns.listUnanalyzed(conversationId);
      if (turns.length > 0) await this.retain(conversationId, turns, 'flush');
      this.logger.info('memory flushed', { conversationId, reason, turns: turns.length });
    }).catch((error: unknown) => this.logError('flush failed', conversationId, error));
  }

  start(): void {
    this.outbox.start();
  }

  async stop(): Promise<void> {
    await this.outbox.stop();
  }

  /** Records the retention (turns analyzed in the same transaction) and wakes the pump. */
  private async retain(conversationId: string, turns: TurnRecord[], reason: 'batch' | 'flush'): Promise<void> {
    const id = uuid();
    await this.options.storage.memoryRetentions.createForTurns({
      id,
      conversationId,
      turnIds: turns.map((turn) => turn.id),
      documentId: `conversation:${conversationId}`,
      operationId: id,
      reason,
    });
    this.outbox.wake();
  }

  private async buildRetain(row: MemoryRetentionRecord): Promise<RetainRequest | null> {
    const turns = await this.transcriptOf(row.conversationId, row.turnIds);
    if (turns.length === 0) return null;
    return {
      documentId: row.documentId,
      operationId: row.operationId,
      turns,
      context: this.describeSpeakers(),
      timestamp: turns[turns.length - 1]!.at,
      metadata: { conversationId: row.conversationId, reason: row.reason },
    };
  }

  /** User-visible text only: user words, delivered background reports, the assistant's replies. */
  private async transcriptOf(conversationId: string, turnIds: string[]): Promise<TranscriptTurn[]> {
    const turns = (await Promise.all(turnIds.map((id) => this.options.storage.turns.get(id))))
      .filter((turn): turn is TurnRecord => turn !== null && turn.conversationId === conversationId)
      .sort((a, b) => a.seq - b.seq);
    const byTurn = new Map<string, MessageRecord[]>();
    for (const message of await this.options.storage.messages.transcript(conversationId, null)) {
      if (!message.turnId) continue;
      byTurn.set(message.turnId, [...(byTurn.get(message.turnId) ?? []), message]);
    }
    const lines: TranscriptTurn[] = [];
    for (const turn of turns) {
      const at = turn.endedAt ?? turn.startedAt;
      for (const message of byTurn.get(turn.id) ?? []) {
        if (message.role === 'user') {
          lines.push({ speaker: 'User', at: turn.startedAt, text: message.envelope?.text ?? contentText(message.content) });
          for (const update of message.envelope?.updates ?? []) {
            lines.push({ speaker: `Background task ${update.title}`, at: turn.startedAt, text: update.report });
          }
        } else {
          lines.push({ speaker: this.options.config.assistant.name, at, text: contentText(message.content) });
        }
      }
    }
    return lines.filter((line) => line.text.trim() !== '');
  }

  private describeSpeakers(): string {
    const name = this.options.config.assistant.name;
    return `Conversation between the user (User) and the assistant ${name}. "Background task" lines report work the assistant ran for the user.`;
  }

  private serial(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tail = next.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }

  private logError(message: string, conversationId: string, error: unknown): void {
    this.logger.error(message, { conversationId, error: errorMessage(error) });
  }

  private iso(): string {
    return isoAt(this.clock.now());
  }
}

export function createMemoryCoordinator(options: MemoryCoordinatorOptions): MemoryCoordinator {
  return new StoreMemoryCoordinator(options);
}

/** The shape automatic recall hands to the turn envelope (the trace keeps the ids only). */
function toRecalledMemory(fact: MemoryFact): RecalledMemory {
  return {
    id: fact.id,
    text: fact.text,
    type: fact.type,
    ...(fact.occurredAt || fact.mentionedAt ? { date: fact.occurredAt ?? fact.mentionedAt } : {}),
  };
}
