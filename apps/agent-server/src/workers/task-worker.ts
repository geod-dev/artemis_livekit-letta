import type { Clock } from '@artemis/core';
import type { TaskRecord } from '@artemis/storage';
import { isoAt } from '../util/time.ts';
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

  /**
   * Failed outcome for a task whose row cannot be read back after it ended (the row is gone,
   * or the store failed while ending it). The worker still settles, so the supervisor ends the
   * task instead of waiting forever. Only the fields the worker knows are filled.
   */
  protected lostOutcome(
    known: Pick<TaskRecord, 'id' | 'conversationId' | 'kind' | 'title' | 'originMode'> & Partial<TaskRecord>,
    report: string
  ): TaskOutcome {
    const now = isoAt(this.clock.now());
    return {
      task: {
        prompt: null,
        subagentType: null,
        command: null,
        cwd: null,
        exitCode: null,
        stdoutTail: null,
        stderrTail: null,
        outputPath: null,
        needsInput: false,
        originTurnId: null,
        originToolCallId: null,
        parentTaskId: null,
        resumedFromTaskId: null,
        depth: 0,
        model: null,
        usage: null,
        stopRequestedAt: null,
        startedAt: now,
        ...known,
        status: 'failed',
        report,
        endedAt: now,
      },
    };
  }

  /** Request a stop: the task ends `cancelled`. */
  abstract stop(reason: string): Promise<void>;

  /** A running task is always active (keeps its main worker alive too). */
  isActive(_now: number): boolean {
    return this.currentState === 'busy' || this.currentState === 'spawning';
  }
}
