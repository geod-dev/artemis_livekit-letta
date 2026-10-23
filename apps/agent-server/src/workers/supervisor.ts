import { KeyedRegistry, uuid } from '@artemis/core';
import type { TaskRecord } from '@artemis/storage';
import type { WorkerEnv } from './env.ts';
import { CommandTaskWorker, type CommandTaskInput } from './command-task-worker.ts';
import { MainAgentWorker } from './main-agent-worker.ts';
import { SubagentTaskWorker } from './subagent-task-worker.ts';
import type { TaskWorker } from './task-worker.ts';
import type { SubagentSpec, SubagentStartMode } from './types.ts';
import { isoAt, messageOf } from './util.ts';

/** Reaper period of the main agent workers. */
const REAPER_PERIOD_MS = 15_000;

/** Not yet terminal: spawning, busy or stopping. */
function isLive(worker: TaskWorker): boolean {
  return worker.state !== 'stopped' && worker.state !== 'failed';
}

/**
 * Owns every live worker. Main agent workers live in a `KeyedRegistry` (idle
 * `workers.idleTimeoutMs`, swept every 15 s); a main worker is active while it
 * runs or queues a turn, while its conversation has a running task worker, or
 * while a call is active. Task workers are tracked by task id and removed when
 * their outcome settles; a finished task is persisted by its worker, then
 * handed to the background delivery service (background starts only).
 *
 * Boot recovery (`recover()`): running turns -> failed('interrupted by restart')
 * with synthetic results for dangling tool uses, running tool calls -> cancelled,
 * inflight updates -> reverted, running tasks -> failed with an update.
 */
export class WorkerSupervisor {
  private readonly mains: KeyedRegistry<MainAgentWorker>;
  private readonly tasks = new Map<string, TaskWorker>();

  constructor(private readonly env: WorkerEnv) {
    this.mains = new KeyedRegistry<MainAgentWorker>({
      create: async (conversationId) => {
        const worker = new MainAgentWorker(conversationId, env, (id) => this.hasActiveTasks(id));
        await worker.start();
        return worker;
      },
      idleMs: env.config.workers.idleTimeoutMs,
      sweepEveryMs: REAPER_PERIOD_MS,
      clock: env.clock,
      logger: env.logger.child('reaper'),
    });
  }

  /** Get or spawn (respawn) the conversation's main worker. */
  mainAgent(conversationId: string): Promise<MainAgentWorker> {
    return this.mains.get(conversationId);
  }

  peekMainAgent(conversationId: string): MainAgentWorker | undefined {
    return this.mains.peek(conversationId);
  }

  /** Starts an update turn for a conversation (spawning its worker if it was reaped). */
  wake(conversationId: string): void {
    void this.mainAgent(conversationId)
      .then((worker) => worker.submit({ kind: 'update', modality: 'text', mode: 'text', effort: 'low', text: '' }).done)
      .catch((error: unknown) => {
        this.env.logger.error('wake failed', { conversationId, error: messageOf(error) });
      });
  }

  /**
   * Registers a subagent worker in the `spawning` state, before its task row exists, so that
   * archive and stop reach it from this moment on. The worker is started by `startSubagent`.
   */
  registerSubagent(taskId: string, spec: SubagentSpec): SubagentTaskWorker {
    const worker = new SubagentTaskWorker(taskId, spec, this.env);
    this.tasks.set(taskId, worker);
    this.touchMainAgent(spec.conversationId);
    return worker;
  }

  /** Drops a registered worker whose task row could not be created (it never started). */
  forgetSubagent(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /** Starts a registered subagent worker; its task row must already exist. */
  async startSubagent(worker: SubagentTaskWorker, mode: SubagentStartMode): Promise<SubagentTaskWorker> {
    try {
      await worker.start();
    } catch (error) {
      await this.failTask(worker.taskId, messageOf(error), mode === 'background');
      if (mode === 'synchronous') throw error;
      return worker;
    }
    this.watch(worker, mode === 'background');
    return worker;
  }

  /** Adopts a running command process as a background task (its output is replayed). */
  async adoptCommand(input: CommandTaskInput): Promise<CommandTaskWorker> {
    const worker = new CommandTaskWorker(input, {
      storage: this.env.storage,
      workspace: this.env.workspace,
      clock: this.env.clock,
      logger: this.env.logger,
    });
    this.tasks.set(input.taskId, worker);
    this.touchMainAgent(input.conversationId);
    await worker.start();
    this.watch(worker, true);
    return worker;
  }

  /** Stops a running task worker; false when no such task is running in this process. */
  async stopTask(taskId: string, reason: string): Promise<boolean> {
    const worker = this.tasks.get(taskId);
    if (!worker || !isLive(worker)) return false;
    await worker.stop(reason);
    return true;
  }

  /**
   * Archive: stops every non-terminal task worker of the conversation (spawning, busy
   * or stopping) and disposes its main worker (aborting any turn). Idempotent; a later
   * message respawns the worker.
   */
  async stopConversation(conversationId: string, reason = 'conversation archived'): Promise<void> {
    const live = [...this.tasks.values()].filter((worker) => worker.conversationId === conversationId && isLive(worker));
    await Promise.allSettled(live.map((worker) => worker.stop(reason)));
    await this.mains.dispose(conversationId, reason);
  }

  /** A running task of the conversation keeps its main worker alive. */
  hasActiveTasks(conversationId: string): boolean {
    const now = this.env.clock.now();
    for (const worker of this.tasks.values()) {
      if (worker.conversationId === conversationId && worker.isActive(now)) return true;
    }
    return false;
  }

  /** Subagent workers that are registered and not yet finished (spawning included). */
  runningSubagentCount(): number {
    let count = 0;
    for (const worker of this.tasks.values()) {
      if (worker instanceof SubagentTaskWorker) count += 1;
    }
    return count;
  }

  /** Boot recovery: must run before the server accepts requests. */
  async recover(): Promise<void> {
    const { storage, logger } = this.env;
    const reason = 'interrupted by restart';
    const turnIds = await storage.turns.failRunning(reason);
    for (const turnId of turnIds) {
      const turn = await storage.turns.get(turnId);
      if (turn) await this.closeDanglingToolUses(turn.conversationId);
    }
    const cancelled = await storage.toolCalls.cancelRunning(reason);
    const reverted = await storage.updates.revertInflight();
    const running = await storage.tasks.listRunning();
    for (const task of running) await this.failTask(task.id, 'Interrupted by a server restart', true);
    logger.info('recovered after restart', { turns: turnIds.length, toolCalls: cancelled, updates: reverted, tasks: running.length });
  }

  start(): void {
    this.mains.start();
  }

  /** One reaper pass at `now` (the registry runs it every 15 s once started); returns reaped conversations. */
  reap(now: number = this.env.clock.now()): Promise<string[]> {
    return this.mains.sweep(now);
  }

  /** Stops task workers, then the main workers (their turns are aborted). */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.tasks.values()].map((worker) => worker.dispose('shutdown')));
    await this.mains.close('shutdown');
  }

  private watch(worker: TaskWorker, deliver: boolean): void {
    void worker.outcome
      .then(({ task }) => this.onTaskEnded(task, deliver))
      .catch((error: unknown) => {
        this.env.logger.error('task end handling failed', { taskId: worker.taskId, error: messageOf(error) });
      });
  }

  private async onTaskEnded(task: TaskRecord, deliver: boolean): Promise<void> {
    this.tasks.delete(task.id);
    this.touchMainAgent(task.conversationId);
    this.env.hub.publish(task.conversationId, {
      type: 'task',
      taskId: task.id,
      status: 'finished',
      title: task.title,
      kind: task.kind,
    });
    if (!deliver) return;
    try {
      await this.env.delivery.taskFinished(task);
    } catch (error) {
      this.env.logger.error('delivering a finished task failed', { taskId: task.id, error: messageOf(error) });
    }
  }

  /** Persists a task as failed (its worker never ran) and ends it like any other task. */
  private async failTask(taskId: string, report: string, deliver: boolean): Promise<void> {
    const finished = await this.env.storage.tasks.finish(taskId, {
      status: 'failed',
      report,
      needsInput: false,
      exitCode: null,
      stdoutTail: null,
      stderrTail: null,
      usage: null,
      endedAt: isoAt(this.env.clock.now()),
    });
    const task = finished ?? (await this.env.storage.tasks.get(taskId));
    this.tasks.delete(taskId);
    if (task) await this.onTaskEnded(task, deliver);
  }

  /** A transcript that ends with tool uses no result was stored for (interrupted turn): answer them as errors. */
  private async closeDanglingToolUses(conversationId: string): Promise<void> {
    const { storage } = this.env;
    const transcript = await storage.messages.transcript(conversationId, null);
    const last = transcript.at(-1);
    if (!last || last.role !== 'assistant') return;
    const toolUseIds = (last.content as Array<{ type?: string; id?: string }>).flatMap((block) =>
      block.type === 'tool_use' && block.id ? [block.id] : []
    );
    if (toolUseIds.length === 0) return;
    await storage.messages.append({
      id: uuid(),
      conversationId,
      taskId: null,
      turnId: last.turnId,
      role: 'user',
      content: toolUseIds.map((toolUseId) => ({
        type: 'tool_result',
        toolUseId,
        content: [{ type: 'text', text: 'Interrupted by a server restart' }],
        isError: true,
      })),
      envelope: null,
      provider: null,
      model: null,
      providerMessageId: null,
      stopReason: null,
      usage: null,
      timings: null,
    });
  }

  private touchMainAgent(conversationId: string): void {
    this.mains.peek(conversationId)?.markActivity();
  }
}
