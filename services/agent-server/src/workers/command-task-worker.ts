import type { Clock, Logger } from '@artemis/core';
import type { Storage, TaskRecord } from '@artemis/storage';
import type { ProcessExit, WorkspaceProcess, WorkspaceTransport } from '@artemis/workspace';
import { TaskWorker } from './task-worker.ts';
import type { TaskOutcome } from './types.ts';
import { isoAt, messageOf, safely } from './util.ts';

const PROGRESS_EVERY_MS = 2_000;
const TAIL_BYTES = 8_192;
/** How long the output may keep draining after the process exited (children may hold the pipes). */
const DRAIN_GRACE_MS = 2_000;
const REPORT_TAIL_CHARS = 4_000;
/** Cap on the full log written to `outputPath`; the oldest output is dropped and the tail kept. */
export const COMMAND_LOG_MAX_BYTES = 1024 * 1024;

export interface CommandTaskInput {
  taskId: string;
  conversationId: string;
  /** The running command; its output is buffered from spawn, so adoption loses nothing. */
  process: WorkspaceProcess;
  /** Workspace-relative log path (`data/tasks/<taskId>.log`). */
  outputPath: string;
  command: string;
}

export interface CommandTaskDeps {
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
    void this.run().then((outcome) => {
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

  /** Never rejects: a persistence failure is logged and the outcome still settles with the task row. */
  private async run(): Promise<TaskOutcome> {
    const { process } = this.input;
    const { storage, workspace, clock, logger } = this.deps;
    const log = new BoundedLog(COMMAND_LOG_MAX_BYTES);
    const drain = (async () => {
      for await (const chunk of process.output()) log.append(chunk.text);
    })().catch((error: unknown) => {
      log.append(`\n[output error: ${messageOf(error)}]`);
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
    if (!task) throw new Error(`Task ${this.taskId} disappeared`);
    return { task };
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

/** Newest `limit` bytes of a text stream; older text is dropped behind a notice. */
class BoundedLog {
  private readonly pieces: { text: string; bytes: number }[] = [];
  private head = 0;
  private retainedBytes = 0;
  private droppedBytes = 0;

  constructor(private readonly limit: number) {}

  append(text: string): void {
    if (!text) return;
    const bytes = Buffer.byteLength(text);
    this.pieces.push({ text, bytes });
    this.retainedBytes += bytes;
    while (this.retainedBytes > this.limit && this.pieces.length - this.head > 1) {
      const old = this.pieces[this.head++]!;
      this.retainedBytes -= old.bytes;
      this.droppedBytes += old.bytes;
    }
    if (this.retainedBytes > this.limit) {
      const last = this.pieces[this.pieces.length - 1]!;
      const buffer = Buffer.from(last.text);
      const kept = buffer.subarray(buffer.length - this.limit);
      this.droppedBytes += buffer.length - kept.length;
      last.text = kept.toString('utf8');
      last.bytes = kept.length;
      this.retainedBytes = kept.length;
    }
    if (this.head > 1024 && this.head * 2 > this.pieces.length) {
      this.pieces.splice(0, this.head);
      this.head = 0;
    }
  }

  toString(): string {
    const body = this.pieces
      .slice(this.head)
      .map((piece) => piece.text)
      .join('');
    return this.droppedBytes > 0 ? `[output truncated: ${this.droppedBytes} bytes omitted]\n${body}` : body;
  }
}
