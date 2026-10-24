import { type Clock, type Logger, errorMessage } from '@artemis/core';
import type { Storage, TaskRecord } from '@artemis/storage';
import type { ProcessExit, WorkspaceProcess, WorkspaceTransport } from '@artemis/workspace';
import { TaskWorker } from './task-worker.ts';
import type { TaskOutcome } from './types.ts';
import { isoAt } from '../util/time.ts';
import { safely } from './safely.ts';
import { BoundedLog } from './bounded-log.ts';

const PROGRESS_EVERY_MS = 2_000;
const TAIL_BYTES = 8_192;
/** How long the output may keep draining after the process exited (children may hold the pipes). */
const DRAIN_GRACE_MS = 2_000;
const REPORT_TAIL_CHARS = 4_000;
/** Cap on the full log written to `outputPath`; the oldest output is dropped and the tail kept. */
const COMMAND_LOG_MAX_BYTES = 1024 * 1024;

export interface CommandTaskInput {
  taskId: string;
  conversationId: string;
  /** The running command; its output is buffered from spawn, so adoption loses nothing. */
  process: WorkspaceProcess;
  /** Workspace-relative log path (`data/tasks/<taskId>.log`). */
  outputPath: string;
  command: string;
}

interface CommandTaskDeps {
  storage: Storage;
  workspace: WorkspaceTransport;
  clock: Clock;
  logger: Logger;
}

/**
 * A background shell command. Either started in the background
 * (`run_in_background`) or adopted from a foreground `bash` call that outlived
 * the handoff delay: it takes over the SAME `WorkspaceProcess` (no restart),
 * replays its buffered output, writes the full log to `outputPath`, persists
 * stdout/stderr tails every ~2 s, and on exit finishes the task: exit 0 ->
 * completed, non-zero/signal/timeout -> failed, stop -> cancelled. The report
 * is the command, its exit status and the output tails.
 */
export class CommandTaskWorker extends TaskWorker {
  readonly kind = 'command-task' as const;
  readonly taskId: string;
  readonly conversationId: string;
  private stopRequested = false;
  private stopReason: string | null = null;
  private progressTimer: { cancel(): void } | undefined;

  constructor(
    private readonly input: CommandTaskInput,
    private readonly deps: CommandTaskDeps
  ) {
    super(deps.clock);
    this.taskId = input.taskId;
    this.conversationId = input.conversationId;
  }

  /** Starts following the process; the outcome settles when it exits and the task is persisted. */
  async start(): Promise<void> {
    this.currentState = 'busy';
    this.touch();
    this.progressTimer = this.deps.clock.setInterval(() => void this.persistProgress(), PROGRESS_EVERY_MS);
    void this.run()
      .catch((error: unknown) => this.lostTask(`Task ${this.taskId} could not be finished: ${errorMessage(error)}`))
      .then((outcome) => {
        this.progressTimer?.cancel();
        this.settle(outcome);
      });
  }

  async stop(reason: string): Promise<void> {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.stopReason = reason;
    await this.deps.storage.tasks.requestStop(this.taskId, isoAt(this.deps.clock.now()));
    await this.input.process.kill();
  }

  /** Kills the process in every state (a spawning worker still owns a running process). */
  async dispose(reason: string): Promise<void> {
    if (this.currentState === 'stopped') return;
    await this.stop(reason);
    if (this.currentState !== 'spawning') await this.outcome;
  }

  /** A persistence failure is logged by `safely`; a store failure while ending the task is turned into a failed outcome by `start`. */
  private async run(): Promise<TaskOutcome> {
    const { process } = this.input;
    const { storage, workspace, clock, logger } = this.deps;
    const log = new BoundedLog(COMMAND_LOG_MAX_BYTES);
    const drain = (async () => {
      for await (const chunk of process.output()) log.append(chunk.text);
    })().catch((error: unknown) => {
      log.append(`\n[output error: ${errorMessage(error)}]`);
    });
    const exit = await process.exited;
    let timer: { cancel(): void } | undefined;
    await Promise.race([
      drain,
      new Promise<void>((resolve) => {
        timer = clock.setTimeout(resolve, DRAIN_GRACE_MS);
      }),
    ]);
    timer?.cancel();

    const status = this.stopRequested ? 'cancelled' : exit.exitCode === 0 && !exit.signal && !exit.timedOut ? 'completed' : 'failed';
    const tails = process.tail(TAIL_BYTES);
    await safely(logger, 'command log', () => workspace.writeFile(this.input.outputPath, log.toString()));
    const finished = await storage.tasks.finish(this.taskId, {
      status,
      report: this.reportOf(exit, tails),
      needsInput: false,
      exitCode: exit.exitCode,
      stdoutTail: tails.stdout,
      stderrTail: tails.stderr,
      usage: null,
      endedAt: isoAt(clock.now()),
    });
    const task: TaskRecord | null = finished ?? (await storage.tasks.get(this.taskId));
    if (!task) return this.lostTask(`Task ${this.taskId} disappeared before its outcome was stored.`);
    return { task };
  }

  private lostTask(report: string): TaskOutcome {
    return this.lostOutcome(
      {
        id: this.taskId,
        conversationId: this.conversationId,
        kind: 'command',
        title: this.input.command,
        command: this.input.command,
        outputPath: this.input.outputPath,
        originMode: 'text',
      },
      report
    );
  }

  private async persistProgress(): Promise<void> {
    const tails = this.input.process.tail(TAIL_BYTES);
    await safely(this.deps.logger, 'command progress', () =>
      this.deps.storage.tasks.updateProgress(this.taskId, { stdoutTail: tails.stdout, stderrTail: tails.stderr })
    );
  }

  private reportOf(exit: ProcessExit, tails: { stdout: string; stderr: string }): string {
    const parts = [`Command: ${this.input.command}`];
    if (exit.timedOut) parts.push('Killed: the command exceeded its maximum lifetime and was stopped.');
    else if (exit.exitCode !== null) parts.push(`Exit code: ${exit.exitCode}.`);
    else parts.push(`Terminated by ${exit.signal ?? 'a signal'}.`);
    if (this.stopRequested) parts.push(`Stopped: ${this.stopReason ?? 'by request'}.`);
    if (tails.stdout.trim()) parts.push(`stdout:\n${tails.stdout.slice(-REPORT_TAIL_CHARS).replace(/\n$/, '')}`);
    if (tails.stderr.trim()) parts.push(`stderr:\n${tails.stderr.slice(-REPORT_TAIL_CHARS).replace(/\n$/, '')}`);
    parts.push(`Full output: ${this.input.outputPath}`);
    return parts.join('\n');
  }
}
