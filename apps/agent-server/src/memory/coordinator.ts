import { type Clock, type Logger, consoleLogger, systemClock, uuid } from '@artemis/core';
import type { RecalledMemory, Repositories, MemoryRetentionRecord, MessageRecord, RecallTrace, TurnRecord } from '@artemis/storage';
import { recallBudget, type MemoryStore, type RetainRequest, type TranscriptTurn } from '@artemis/memory';
import type { AgentServerConfig } from '../config.ts';
import { runWithTimeout } from './abort.ts';

/**
 * Applies the memory rules (architecture.md#7). Talks to long-term memory only
 * through `MemoryStore`; storage holds the outbox and the bookkeeping.
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
export abstract class MemoryCoordinator {
  abstract conversationActivated(conversationId: string): Promise<void>;
  abstract recallFor(input: RecallInput): Promise<RecalledMemory[]>;
  abstract turnCompleted(turn: TurnRecord): Promise<void>;
  /** Retains every unanalyzed completed turn of the conversation (reason `switch` or `shutdown`). */
  abstract flush(conversationId: string, reason: 'switch' | 'shutdown'): Promise<void>;
  /** Starts the outbox pump (periodic) and submits leftovers from a previous run. */
  abstract start(): void;
  /** Stops the pump and waits for the submission in flight. */
  abstract stop(): Promise<void>;
}

interface RecallInput {
  conversationId: string;
  turnId: string;
  modality: 'text' | 'voice';
  effort?: TurnRecord['effort'];
  /** The user's words (update turns: titles and first lines of reports). */
  query: string;
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

const LAST_ACTIVE_KEY = 'last_active_conversation_id';
const PUMP_BATCH = 10;
const MAX_BACKOFF_MS = 5 * 60_000;

class StoreMemoryCoordinator extends MemoryCoordinator {
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
    super();
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
      const previous = await this.options.storage.appState.swap<string>(LAST_ACTIVE_KEY, conversationId);
      if (typeof previous === 'string' && previous !== conversationId) {
        await this.flush(previous, 'switch');
      }
    } catch (error) {
      this.logger.error('activation bookkeeping failed', { conversationId, error: messageOf(error) });
    }
  }

  async recallFor(input: RecallInput): Promise<RecalledMemory[]> {
    if (!this.enabled) return [];
    const { memory } = this.options.config;
    const budget = recallBudget({ modality: input.modality, effort: input.effort });
    const timeoutMs = input.modality === 'voice' ? memory.recallTimeoutMs.voice : memory.recallTimeoutMs.text;
    const started = this.clock.now();
    const trace: RecallTrace = { budget, query: input.query, memoryIds: [], durationMs: 0 };
    let memories: RecalledMemory[] = [];
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
      const injected = await this.options.storage.recallLedger.injectedIds(input.conversationId);
      const fresh = result.facts.filter((fact) => !injected.has(fact.id));
      if (fresh.length > 0) {
        await this.options.storage.recallLedger.record(
          input.conversationId,
          input.turnId,
          fresh.map((fact) => fact.id)
        );
      }
      memories = fresh.map((fact) => ({
        id: fact.id,
        text: fact.text,
        type: fact.type,
        ...(fact.occurredAt || fact.mentionedAt ? { date: fact.occurredAt ?? fact.mentionedAt } : {}),
      }));
      trace.memoryIds = memories.map((item) => item.id);
    } catch (error) {
      trace.error = messageOf(error);
      this.logger.warn('recall skipped', { turnId: input.turnId, error: trace.error });
    }
    trace.durationMs = this.clock.now() - started;
    await this.options.storage.turns.setRecall(input.turnId, trace).catch((error: unknown) => {
      this.logger.warn('recall trace not stored', { turnId: input.turnId, error: messageOf(error) });
    });
    return memories;
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
        this.logger.error('outbox pump failed', { error: messageOf(error) });
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
      const message = messageOf(error);
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
          lines.push({ speaker: 'User', at: turn.startedAt, text: message.envelope?.text ?? textOf(message.content) });
          for (const update of message.envelope?.updates ?? []) {
            lines.push({ speaker: `Background task ${update.title}`, at: turn.startedAt, text: update.report });
          }
        } else {
          lines.push({ speaker: this.options.config.assistant.name, at, text: textOf(message.content) });
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
    this.logger.error(message, { conversationId, error: messageOf(error) });
  }

  private iso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

export function createMemoryCoordinator(options: MemoryCoordinatorOptions): MemoryCoordinator {
  return new StoreMemoryCoordinator(options);
}

/** Exponential backoff: 2 s, 4 s, 8 s ... capped at 5 minutes. */
function retryDelayMs(attempts: number): number {
  return Math.min(1_000 * 2 ** attempts, MAX_BACKOFF_MS);
}

function textOf(content: unknown[]): string {
  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return [];
      const { type, text } = block as { type?: unknown; text?: unknown };
      return type === 'text' && typeof text === 'string' ? [text] : [];
    })
    .join('\n');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
