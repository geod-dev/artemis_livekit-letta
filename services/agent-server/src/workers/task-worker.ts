import type { Clock } from '@artemis/core';
import type { TaskOutcome } from './types.ts';
import { Worker } from './worker.ts';

/**
 * A worker bound to one task of a conversation. It dies when the task ends:
 * the outcome is persisted (`tasks` row) and handed to the supervisor, which
 * turns it into a background update for the main agent (unless synchronous).
 */
export abstract class TaskWorker extends Worker {
  abstract readonly taskId: string;

  private readonly settled: Promise<TaskOutcome>;
  private resolveSettled!: (outcome: TaskOutcome) => void;

  constructor(clock?: Clock) {
    super(clock);
    this.settled = new Promise<TaskOutcome>((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  get id(): string {
    return this.taskId;
  }

  /** Resolves once the task reached a terminal status and was persisted (never rejects). */
  get outcome(): Promise<TaskOutcome> {
    return this.settled;
  }

  protected settle(outcome: TaskOutcome): void {
    this.currentState = 'stopped';
    this.resolveSettled(outcome);
  }

  /** Request a stop: the task ends `cancelled`. */
  abstract stop(reason: string): Promise<void>;

  /** A running task is always active (keeps its main worker alive too). */
  isActive(_now: number): boolean {
    return this.currentState === 'busy' || this.currentState === 'spawning';
  }
}
