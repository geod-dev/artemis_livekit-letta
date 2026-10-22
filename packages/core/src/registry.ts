import type { Clock } from './clock.ts';
import { notImplemented } from './errors.ts';

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
}

/**
 * Lazily created entries keyed by id, created at most once concurrently,
 * disposed by a periodic idle sweep, and tombstoned while a dispose runs so a
 * concurrent `get` waits for it and then recreates the entry.
 */
export class KeyedRegistry<T extends Reapable> {
  constructor(readonly options: KeyedRegistryOptions<T>) {}

  get(_key: string): Promise<T> {
    return notImplemented('KeyedRegistry.get');
  }

  peek(_key: string): T | undefined {
    return notImplemented('KeyedRegistry.peek');
  }

  keys(): string[] {
    return notImplemented('KeyedRegistry.keys');
  }

  /** One reaper pass; returns the disposed keys. */
  sweep(_now?: number): Promise<string[]> {
    return notImplemented('KeyedRegistry.sweep');
  }

  dispose(_key: string, _reason: string): Promise<void> {
    return notImplemented('KeyedRegistry.dispose');
  }

  start(): void {
    notImplemented('KeyedRegistry.start');
  }

  /** Stop the reaper and dispose every entry. */
  close(_reason?: string): Promise<void> {
    return notImplemented('KeyedRegistry.close');
  }
}
