import { type Clock, type Logger, errorMessage } from '@artemis/core';
import type { MemoryRetentionRecord, Repositories } from '@artemis/storage';
import type { RetainRequest } from '@artemis/memory';
import { runWithTimeout } from '../util/async.ts';
import { isoAt } from '../util/time.ts';

/**
 * The retention outbox pump (docs/architecture.md, "Conversations memory and
 * background work"): submits pending `memory_retentions` rows oldest first, with
 * exponential backoff per row and a terminal state after `maxAttempts`. The
 * coordinator records rows and says what a row sends (`build`) and how (`retain`).
 */
export interface MemoryOutbox {
  /** Starts the periodic pump and runs one pass now. */
  start(): void;
  /** Requests a pump pass; passes do not overlap. */
  wake(): void;
  /** Stops the timer and waits for the pass in flight. */
  stop(): Promise<void>;
}

export interface MemoryOutboxOptions {
  storage: Pick<Repositories, 'memoryRetentions'>;
  /** Builds the store request for a row; null when the row has no user-visible text. */
  build(row: MemoryRetentionRecord): Promise<RetainRequest | null>;
  /** Sends one request to the memory store; rejects on failure. */
  retain(request: RetainRequest, signal: AbortSignal): Promise<unknown>;
  clock: Clock;
  logger: Logger;
  /** Pump period (default 5 s). */
  pumpIntervalMs?: number;
  /** Submission attempts before a retention is terminal (default 10). */
  maxAttempts?: number;
  /** Timeout of one retain call (default 30 s). */
  retainTimeoutMs?: number;
}

const PUMP_BATCH = 10;
const MAX_BACKOFF_MS = 5 * 60_000;

class StoreOutbox implements MemoryOutbox {
  private readonly pumpIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retainTimeoutMs: number;
  /** Retention id -> earliest next submission (ms). */
  private readonly retryAt = new Map<string, number>();
  private pumping: Promise<void> | null = null;
  private dirty = false;
  private stopped = true;
  private timer: { cancel(): void } | null = null;

  constructor(private readonly options: MemoryOutboxOptions) {
    this.pumpIntervalMs = options.pumpIntervalMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.retainTimeoutMs = options.retainTimeoutMs ?? 30_000;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = this.options.clock.setInterval(() => this.wake(), this.pumpIntervalMs);
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    await this.pumping?.catch(() => undefined);
  }

  wake(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.pumping) return;
    this.pumping = this.drain().finally(() => {
      this.pumping = null;
      if (this.dirty && !this.stopped) this.wake();
    });
  }

  private async drain(): Promise<void> {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      try {
        await this.submitPending();
      } catch (error) {
        this.options.logger.error('outbox pump failed', { error: errorMessage(error) });
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
      if ((this.retryAt.get(row.id) ?? 0) > this.options.clock.now()) continue;
      await this.submit(row);
    }
  }

  private async submit(row: MemoryRetentionRecord): Promise<void> {
    const { clock } = this.options;
    try {
      const request = await this.options.build(row);
      if (request) {
        await runWithTimeout({ clock, timeoutMs: this.retainTimeoutMs }, (signal) =>
          this.options.retain(request, signal)
        );
      }
      await this.options.storage.memoryRetentions.markSubmitted(row.id, isoAt(clock.now()));
      this.retryAt.delete(row.id);
    } catch (error) {
      const message = errorMessage(error);
      const attempts = row.attempts + 1;
      const terminal = attempts >= this.maxAttempts;
      if (terminal) this.retryAt.delete(row.id);
      else this.retryAt.set(row.id, clock.now() + retryDelayMs(attempts));
      this.options.logger.warn('memory retention submission failed', { retentionId: row.id, attempts, terminal, error: message });
      await this.options.storage.memoryRetentions
        .markAttemptFailed(row.id, message, terminal)
        .catch((storageError: unknown) =>
          this.options.logger.error('retention bookkeeping failed', {
            conversationId: row.conversationId,
            error: errorMessage(storageError),
          })
        );
    }
  }
}

export function createMemoryOutbox(options: MemoryOutboxOptions): MemoryOutbox {
  return new StoreOutbox(options);
}

/** Exponential backoff: 2 s, 4 s, 8 s ... capped at 5 minutes. */
function retryDelayMs(attempts: number): number {
  return Math.min(1_000 * 2 ** attempts, MAX_BACKOFF_MS);
}
