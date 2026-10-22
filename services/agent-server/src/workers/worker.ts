import type { Reapable } from '@artemis/core';
import type { WorkerKind, WorkerState } from './types.ts';

/**
 * Base of every worker: a unit that owns an LLM loop or a process for one
 * conversation or task. Workers hold no state that is not reconstructable from
 * storage: dropping one and spawning it again must be safe.
 */
export abstract class Worker implements Reapable {
  abstract readonly kind: WorkerKind;
  abstract readonly id: string;
  abstract readonly conversationId: string;

  protected currentState: WorkerState = 'spawning';
  protected lastActivity = Date.now();

  get state(): WorkerState {
    return this.currentState;
  }

  lastActivityAt(): number {
    return this.lastActivity;
  }

  protected touch(now = Date.now()): void {
    this.lastActivity = now;
  }

  /** Load state from storage; `idle` (main) or `busy` (task) afterwards. */
  abstract start(): Promise<void>;

  abstract isActive(now: number): boolean;

  /** Stop work (abort turn / kill process) and release resources. Idempotent. */
  abstract dispose(reason: string): Promise<void>;
}
