import { errorMessage } from '@artemis/core';
import type { TaskRecord } from '@artemis/storage';
import type { Toolset } from '@artemis/tools';
import { createBackgroundDelivery, type BackgroundDeliveryService } from '../tasks/delivery.ts';
import { createTaskService, type TaskWorkers } from '../tasks/task-service.ts';
import type { AgentToolContext } from '../tools/index.ts';
import type { SubagentSpec, TaskPort } from '../tools/task-port.ts';
import { isoAt } from '../util/time.ts';
import { CommandTaskWorker, type CommandTaskInput } from './command-task-worker.ts';
import type { WorkerBase, WorkerEnv } from './env.ts';
import { MainAgentWorker } from './main-agent-worker.ts';
import { RESTART_FAILURE } from './restart.ts';
import { recoverAfterRestart } from './recovery.ts';
import { KeyedRegistry } from './registry.ts';
import { SubagentTaskWorker } from './main-agent/subagent-task-worker.ts';
import type { TaskWorker } from './task-worker.ts';
import type { SubagentStartMode } from './types.ts';

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
export class WorkerSupervisor implements TaskWorkers {
  readonly taskService: TaskPort;
  readonly delivery: BackgroundDeliveryService;
  readonly toolset: Toolset<AgentToolContext>;
  private readonly env: WorkerEnv;
  private readonly mains: KeyedRegistry<MainAgentWorker>;
  private readonly taskWorkers = new Map<string, TaskWorker>();
  /** Background work in flight: task ends (with their delivery) and wakes of main workers. */
  private readonly pending = new Set<Promise<void>>();

  constructor(base: WorkerBase, createToolset: (tasks: TaskPort) => Toolset<AgentToolContext>) {
    this.delivery = createBackgroundDelivery({
      storage: base.storage,
      hub: base.hub,
      calls: base.calls,
      clock: base.clock,
      logger: base.logger,
      wake: (conversationId) => this.wake(conversationId),
    });
    this.taskService = createTaskService(
      {
        storage: base.storage,
        hub: base.hub,
        clock: base.clock,
        subagents: base.subagents,
        maxSubagents: base.config.workers.maxSubagents,
        maxCommandTasks: base.config.workers.maxCommandTasks,
      },
      this
    );
    this.toolset = createToolset(this.taskService);
    this.env = { ...base, delivery: this.delivery, tasks: this.taskService, tools: this.toolset };
    this.mains = new KeyedRegistry<MainAgentWorker>({
      create: async (conversationId) => {
        const worker = new MainAgentWorker(conversationId, this.env, (id) => this.hasActiveTasks(id));
        await worker.start();
        return worker;
      },
      idleMs: base.config.workers.idleTimeoutMs,
      sweepEveryMs: REAPER_PERIOD_MS,
      clock: base.clock,
      logger: base.logger.child('reaper'),
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
    void this.track(
      this.mainAgent(conversationId)
        .then((worker) => worker.submit({ kind: 'update', modality: 'text', mode: 'text', effort: 'low', text: '' }).done)
        .then(() => undefined)
        .catch((error: unknown) => {
          this.env.logger.error('wake failed', { conversationId, error: errorMessage(error) });
        })
    );
  }

  /**
   * Registers a subagent worker in the `spawning` state, before its task row exists, so that
   * archive and stop reach it from this moment on. The worker is started by `startSubagent`.
   */
  registerSubagent(taskId: string, spec: SubagentSpec): SubagentTaskWorker {
    const worker = new SubagentTaskWorker(taskId, spec, this.env);
    this.taskWorkers.set(taskId, worker);
    this.touchMainAgent(spec.conversationId);
    return worker;
  }

  /** Drops a registered worker whose task row could not be created (it never started). */
  forgetSubagent(taskId: string): void {
    this.taskWorkers.delete(taskId);
  }

  /** Starts a registered subagent worker; its task row must already exist. */
  async startSubagent(worker: SubagentTaskWorker, mode: SubagentStartMode): Promise<SubagentTaskWorker> {
    try {
      await worker.start();
    } catch (error) {
      await this.failTask(worker.taskId, errorMessage(error), mode === 'background');
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
    this.taskWorkers.set(input.taskId, worker);
    this.touchMainAgent(input.conversationId);
    await worker.start();
    this.watch(worker, true);
    return worker;
  }

  /** Stops a running task worker; false when no such task is running in this process. */
  async stopTask(taskId: string, reason: string): Promise<boolean> {
    const worker = this.taskWorkers.get(taskId);
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
    const live = [...this.taskWorkers.values()].filter((worker) => worker.conversationId === conversationId && isLive(worker));
    await Promise.allSettled(live.map((worker) => worker.stop(reason)));
    await this.mains.dispose(conversationId, reason);
  }

  /** A running task of the conversation keeps its main worker alive. */
  hasActiveTasks(conversationId: string): boolean {
    const now = this.env.clock.now();
    for (const worker of this.taskWorkers.values()) {
      if (worker.conversationId === conversationId && worker.isActive(now)) return true;
    }
    return false;
  }

  /** Subagent workers that are registered and not yet finished (spawning included). */
  runningSubagentCount(): number {
    let count = 0;
    for (const worker of this.taskWorkers.values()) {
      if (worker instanceof SubagentTaskWorker) count += 1;
    }
    return count;
  }

  /** Command workers that are registered and not yet finished. */
  runningCommandCount(): number {
    let count = 0;
    for (const worker of this.taskWorkers.values()) {
      if (worker instanceof CommandTaskWorker) count += 1;
    }
    return count;
  }

  /** Boot recovery: must run before the server accepts requests (see `workers/recovery.ts`). */
  recover(): Promise<void> {
    return recoverAfterRestart({
      storage: this.env.storage,
      logger: this.env.logger,
      failTask: (taskId) => this.failTask(taskId, RESTART_FAILURE, true),
    });
  }

  start(): void {
    this.mains.start();
  }

  /**
   * Background work started so far (task ends, delivery, wakes). The test helper
   * `settled` in `test/workers-support.ts` awaits it; production code does not.
   */
  inFlight(): readonly Promise<void>[] {
    return [...this.pending];
  }

  /** Stops task workers, then the main workers (their turns are aborted). */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.taskWorkers.values()].map((worker) => worker.dispose('shutdown')));
    await this.mains.close('shutdown');
  }

  private watch(worker: TaskWorker, deliver: boolean): void {
    void this.track(
      worker.outcome
        .then(({ task }) => this.onTaskEnded(task, deliver))
        .catch((error: unknown) => {
          this.env.logger.error('task end handling failed', { taskId: worker.taskId, error: errorMessage(error) });
        })
    );
  }

  /** Registers background work (task ends, wakes) so that `settled()` can wait for it. */
  private track(work: Promise<void>): Promise<void> {
    this.pending.add(work);
    const forget = () => {
      this.pending.delete(work);
    };
    void work.then(forget, forget);
    return work;
  }

  private async onTaskEnded(task: TaskRecord, deliver: boolean): Promise<void> {
    this.taskWorkers.delete(task.id);
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
      this.env.logger.error('delivering a finished task failed', { taskId: task.id, error: errorMessage(error) });
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
    this.taskWorkers.delete(taskId);
    if (task) await this.onTaskEnded(task, deliver);
  }

  private touchMainAgent(conversationId: string): void {
    this.mains.peek(conversationId)?.markActivity();
  }
}
