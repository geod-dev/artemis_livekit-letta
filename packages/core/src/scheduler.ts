import { notImplemented } from './errors.ts';

/**
 * FIFO promise-chain serializer with a pending limit (port of
 * backend/src/assistant/runtime/scheduler.ts). One per main agent worker:
 * user, voice and update turns of a conversation never overlap.
 */
export class SerialScheduler {
  constructor(readonly maxPending = 32) {}

  /** Number of queued + running jobs. */
  get pending(): number {
    return notImplemented('SerialScheduler.pending');
  }

  get idle(): boolean {
    return notImplemented('SerialScheduler.idle');
  }

  /** Queue `job`; rejects with `BusyError` when `maxPending` would be exceeded. */
  run<T>(_job: () => Promise<T>): Promise<T> {
    return notImplemented('SerialScheduler.run');
  }

  /** Resolves once every job queued so far has settled. */
  drain(): Promise<void> {
    return notImplemented('SerialScheduler.drain');
  }
}
