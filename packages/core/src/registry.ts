import { type Clock, systemClock } from './clock.ts';
import { consoleLogger, type Logger } from './logger.ts';

/** Something the registry can reap when idle (port of runtime/registry.ts). */
export interface Reapable {
  /** True while the entry must not be reaped (busy, active task, active call...). */
  isActive(now: number): boolean;
  /** Epoch ms of the last activity; the reaper compares it with `idleMs`. */
  lastActivityAt(): number;
  dispose(reason: string): Promise<void>;
}

export interface KeyedRegistryOptions<T extends Reapable> {
  create: (key: string) => Promise<T>;
  idleMs: number;
  /** Reaper period. */
  sweepEveryMs: number;
  clock?: Clock;
  onDisposed?: (key: string, reason: string) => void;
  /** Receives reaper and shutdown failures (default: console logger `registry`). */
  logger?: Logger;
}

/**
 * Lazily created entries keyed by id, created at most once concurrently,
 * disposed by a periodic idle sweep, and tombstoned while a dispose runs so a
 * concurrent `get` waits for it and then recreates the entry.
 */
export class KeyedRegistry<T extends Reapable> {
  private readonly entries = new Map<string, T>();
  private readonly creating = new Map<string, Promise<T>>();
  private readonly tombstones = new Map<string, Promise<void>>();
  private readonly clock: Clock;
  private readonly logger: Logger;
  private timer: { cancel(): void } | undefined;

  constructor(readonly options: KeyedRegistryOptions<T>) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? consoleLogger('registry');
  }

  async get(key: string): Promise<T> {
    // A dispose in progress for this key must finish before the entry is recreated.
    for (let tombstone = this.tombstones.get(key); tombstone; tombstone = this.tombstones.get(key)) {
      await tombstone.catch(() => undefined);
    }
    const existing = this.entries.get(key);
    if (existing) return existing;
    const inflight = this.creating.get(key);
    if (inflight) return inflight;
    const created = this.options
      .create(key)
      .then((entry) => {
        this.entries.set(key, entry);
        return entry;
      })
      .finally(() => {
        this.creating.delete(key);
      });
    this.creating.set(key, created);
    return created;
  }

  peek(key: string): T | undefined {
    return this.entries.get(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** One reaper pass; returns the reaped keys. Dispose failures are logged, not thrown. */
  async sweep(now: number = this.clock.now()): Promise<string[]> {
    const { idleMs } = this.options;
    const due = [...this.entries]
      .filter(([, entry]) => !entry.isActive(now) && now - entry.lastActivityAt() > idleMs)
      .map(([key]) => key);
    const results = await Promise.allSettled(due.map((key) => this.dispose(key, 'idle')));
    this.logFailures('idle dispose failed', results, due);
    return due;
  }

  /** Removes the entry (tombstoned until disposed) and disposes it; no-op for unknown keys. */
  async dispose(key: string, reason: string): Promise<void> {
    const creating = this.creating.get(key);
    if (creating) await creating.catch(() => undefined);
    const entry = this.entries.get(key);
    if (!entry) {
      await this.tombstones.get(key)?.catch(() => undefined);
      return;
    }
    this.entries.delete(key);
    const tombstone = (async () => {
      try {
        await entry.dispose(reason);
      } finally {
        this.options.onDisposed?.(key, reason);
      }
    })();
    this.tombstones.set(key, tombstone);
    try {
      await tombstone;
    } finally {
      if (this.tombstones.get(key) === tombstone) this.tombstones.delete(key);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.clock.setInterval(() => {
      void this.sweep();
    }, this.options.sweepEveryMs);
  }

  /** Stop the reaper and dispose every entry. */
  async close(reason = 'shutdown'): Promise<void> {
    this.timer?.cancel();
    this.timer = undefined;
    await Promise.allSettled([...this.creating.values()]);
    const keys = this.keys();
    const results = await Promise.allSettled(keys.map((key) => this.dispose(key, reason)));
    this.logFailures('shutdown dispose failed', results, keys);
    await Promise.allSettled([...this.tombstones.values()]);
  }

  private logFailures(message: string, results: PromiseSettledResult<void>[], keys: string[]): void {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(message, { key: keys[index], error: String(result.reason) });
      }
    });
  }
}
