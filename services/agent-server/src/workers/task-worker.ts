import type { TaskOutcome } from './types.ts';
import { Worker } from './worker.ts';

/**
 * A worker bound to one task of a conversation. It dies when the task ends:
 * the outcome is persisted (`tasks` row) and handed to the background delivery
 * service, which turns it into an update for the main agent.
 */
export abstract class TaskWorker extends Worker {
  abstract readonly taskId: string;

  get id(): string {
    return this.taskId;
  }

  /** Resolves once the task reached a terminal status and was persisted. */
  abstract readonly outcome: Promise<TaskOutcome>;

  /** Request a stop: the task ends `cancelled`. */
  abstract stop(reason: string): Promise<void>;

  /** A running task is always active (keeps its main worker alive too). */
  isActive(_now: number): boolean {
    return this.state !== 'stopped' && this.state !== 'failed';
  }
}
