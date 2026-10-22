import { notImplemented } from '@artemis/core';
import type { WorkspaceProcess } from '@artemis/workspace';
import { TaskWorker } from './task-worker.ts';
import type { TaskOutcome } from './types.ts';

/**
 * A background shell command. Either started in the background
 * (`run_in_background`) or adopted from a foreground `bash` call that outlived
 * the handoff delay: it takes over the SAME `WorkspaceProcess` (no restart),
 * replays its buffered output, writes the full log to `outputPath`
 * (`data/tasks/<taskId>.log`), persists stdout/stderr tails every ~2 s, and on
 * exit finishes the task: exit 0 -> completed, non-zero/signal -> failed,
 * stop -> cancelled. Report = command, exit code and output tails.
 */
export class CommandTaskWorker extends TaskWorker {
  readonly kind = 'command-task' as const;

  constructor(
    readonly taskId: string,
    readonly conversationId: string,
    readonly process: WorkspaceProcess,
    readonly outputPath: string
  ) {
    super();
  }

  get outcome(): Promise<TaskOutcome> {
    return notImplemented('CommandTaskWorker.outcome');
  }

  start(): Promise<void> {
    return notImplemented('CommandTaskWorker.start');
  }

  stop(_reason: string): Promise<void> {
    return notImplemented('CommandTaskWorker.stop');
  }

  dispose(_reason: string): Promise<void> {
    return notImplemented('CommandTaskWorker.dispose');
  }
}
