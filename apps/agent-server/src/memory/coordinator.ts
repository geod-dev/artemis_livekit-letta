import { type Clock, type Logger, consoleLogger, errorMessage, systemClock, uuid } from '@artemis/core';
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

/** The app-state key of the conversation the user wrote to last (swapped on every accepted user message). */
export const LAST_ACTIVE_CONVERSATION_KEY = 'last_active_conversation_id';

/**
 * Applies the memory rules (docs/architecture.md, "Conversations memory and
 * background work"). Talks to long-term memory only through `MemoryStore`;
 * storage holds the outbox and the bookkeeping.
 * - `conversationActivated(id)` on every accepted user message: swaps
 *   `last_active_conversation_id`; when it changed, flushes the previous
 *   conversation's unanalyzed completed turns.
 * - `recallFor(...)` before EVERY assistant answer: budget = `recallBudget`,
 *   timeout voice/text from config, memories already injected are dropped
 *   (`recall ledger`), the trace goes to `turns.recall`. Failures and timeouts
 *   give no memories; the turn proceeds.
 * - `turnCompleted(turn)`: when the conversation has `retainEvery` unanalyzed
 *   completed user turns, the turns up to the last of them are retained.
 * Retention is an outbox (`memory_retentions`): `start()` pumps it with
 * exponential backoff and a terminal state after `maxAttempts`; the operation
 * id is the row id, so retries are idempotent. Memory failures never fail a turn.
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
  clock?: Clock;
  logger?: Logger;
  /** Outbox pump period (default 5 s). */
  pumpIntervalMs?: number;
  /** Submission attempts before a retention is terminal (default 10). */
  maxAttempts?: number;
  /** Timeout of one retain call (default 30 s). */
  retainTimeoutMs?: number;
}

const PUMP_BATCH = 10;
const MAX_BACKOFF_MS = 5 * 60_000;

class StoreMemoryCoordinator implements MemoryCoordinator {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly pumpIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retainTimeoutMs: number;
  /** Per-conversation serialization of batch, flush and recall bookkeeping. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Retention id -> earliest next submission (ms). */
  private readonly retryAt = new Map<string, number>();
  private pumping: Promise<void> | null = null;
  private dirty = false;
  private stopped = true;
  private timer: { cancel(): void } | null = null;

  constructor(private readonly options: MemoryCoordinatorOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? consoleLogger('memory');
    this.pumpIntervalMs = options.pumpIntervalMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.retainTimeoutMs = options.retainTimeoutMs ?? 30_000;
  }

  private get enabled(): boolean {
    return this.options.config.memory.enabled;
  }

  async conversationActivated(conversationId: string): Promise<void> {
    if (!this.enabled) return;
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
    if (!this.enabled) return [];
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
    if (!this.enabled) return;
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
    if (!this.enabled) return;
    await this.serial(conversationId, async () => {
      const turns = await this.options.storage.turns.listUnanalyzed(conversationId);
      if (turns.length > 0) await this.retain(conversationId, turns, 'flush');
      this.logger.info('memory flushed', { conversationId, reason, turns: turns.length });
    }).catch((error: unknown) => this.logError('flush failed', conversationId, error));
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.stopped = false;
    this.timer = this.clock.setInterval(() => this.kick(), this.pumpIntervalMs);
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    await this.pumping?.catch(() => undefined);
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
    this.kick();
  }

  private kick(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.pumping) return;
    this.pumping = this.drain().finally(() => {
      this.pumping = null;
      if (this.dirty && !this.stopped) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      try {
        await this.submitPending();
      } catch (error) {
        this.logger.error('outbox pump failed', { error: errorMessage(error) });
      }
    }
  }

  /**
   * Scans the outbox oldest first. A row in backoff is skipped, and the scan goes on. Every
   * backed-off pending row is in `retryAt`, so widening the window by its size keeps at least
   * `PUMP_BATCH` rows that are not in backoff reachable, even when an outage backs off the oldest ones.
   */
  private async submitPending(): Promise<void> {
    const rows = await this.options.storage.memoryRetentions.listPending(PUMP_BATCH + this.retryAt.size);
    for (const row of rows) {
      if (this.stopped) return;
      if ((this.retryAt.get(row.id) ?? 0) > this.clock.now()) continue;
      await this.submit(row);
    }
  }

  private async submit(row: MemoryRetentionRecord): Promise<void> {
    try {
      const request = await this.buildRetain(row);
      if (request) {
        await runWithTimeout({ clock: this.clock, timeoutMs: this.retainTimeoutMs }, (signal) =>
          this.options.store.retain(request, signal)
        );
      }
      await this.options.storage.memoryRetentions.markSubmitted(row.id, this.iso());
      this.retryAt.delete(row.id);
    } catch (error) {
      const message = errorMessage(error);
      const attempts = row.attempts + 1;
      const terminal = attempts >= this.maxAttempts;
      if (terminal) this.retryAt.delete(row.id);
      else this.retryAt.set(row.id, this.clock.now() + retryDelayMs(attempts));
      this.logger.warn('memory retention submission failed', { retentionId: row.id, attempts, terminal, error: message });
      await this.options.storage.memoryRetentions
        .markAttemptFailed(row.id, message, terminal)
        .catch((storageError: unknown) => this.logError('retention bookkeeping failed', row.conversationId, storageError));
    }
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

/** Exponential backoff: 2 s, 4 s, 8 s ... capped at 5 minutes. */
function retryDelayMs(attempts: number): number {
  return Math.min(1_000 * 2 ** attempts, MAX_BACKOFF_MS);
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
