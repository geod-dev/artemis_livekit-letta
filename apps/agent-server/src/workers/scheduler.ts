import { BusyError } from '@artemis/core';
import { MAX_PENDING_TURNS } from '../config.ts';

/**
 * FIFO promise-chain serializer with a pending limit. One per main agent worker:
 * user, voice and update turns of a conversation never overlap.
 */
export class SerialScheduler {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(readonly maxPending = MAX_PENDING_TURNS) {}

  /** Number of queued + running jobs. */
  get pending(): number {
    return this.queued;
  }

  get idle(): boolean {
    return this.queued === 0;
  }

  /** Queue `job`; rejects with `BusyError` when `maxPending` would be exceeded. */
  run<T>(job: () => Promise<T>): Promise<T> {
    if (this.queued >= this.maxPending) return Promise.reject(new BusyError());
    this.queued++;
    const result = this.tail.then(job);
    const release = () => {
      this.queued--;
    };
    this.tail = result.then(release, release);
    return result;
  }

  /** Resolves once every job queued so far has settled. */
  drain(): Promise<void> {
    return this.tail;
  }
}
