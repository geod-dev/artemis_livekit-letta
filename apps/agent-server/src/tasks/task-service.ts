import { AppError, type Clock, NotFoundError, prefixedId } from '@artemis/core';
import type { ConversationTask } from '@artemis/contracts/chat-types';
import type { Storage, TaskRecord } from '@artemis/storage';
import type { CommandHandoff } from '@artemis/tools/workspace-tools';
import type { WorkspaceProcess } from '@artemis/workspace';
import type { ConversationEventHub } from '../events/hub.ts';
import type { SubagentDefinition } from '../subagents/definitions.ts';
import type { AgentToolContext } from '../tools/index.ts';
import type { SubagentSpec, TaskPort } from '../tools/task-port.ts';
import { DATA_SUBDIRS } from '../config.ts';
import { isoAt } from '../util/time.ts';
import type { SubagentStartMode, TaskOutcome } from '../workers/types.ts';

/**
 * Task lifecycle facade used by tools and the API. Creates `tasks` rows, asks
 * the workers to run them, publishes `task` SSE events, and projects
 * `TaskRecord` into `ConversationTask`. Implements the bash `CommandHandoff`.
 */

export interface TaskServiceDeps {
  storage: Storage;
  hub: ConversationEventHub;
  clock: Clock;
  subagents: readonly SubagentDefinition[];
  /** `workers.maxSubagents`: subagents that may run at once. */
  maxSubagents: number;
  /** `workers.maxCommandTasks`: background command tasks that may run at once. */
  maxCommandTasks: number;
}

/** A command process handed over by the bash tool, to be run as a background task. */
export interface AdoptedCommand {
  taskId: string;
  conversationId: string;
  process: WorkspaceProcess;
  outputPath: string;
  command: string;
}

/** A started subagent worker, as the task service sees it. */
export interface SubagentRun {
  readonly taskId: string;
  readonly outcome: Promise<TaskOutcome>;
  stop(reason: string): Promise<void>;
}

/** The workers a task runs in: implemented by the supervisor, which owns their lifecycle. */
export interface TaskWorkers {
  runningSubagentCount(): number;
  /** Command workers registered in this process and not yet finished. */
  runningCommandCount(): number;
  /** Registers a subagent before its task row exists, so archive and stop reach it at once. */
  registerSubagent(taskId: string, spec: SubagentSpec): SubagentRun;
  forgetSubagent(taskId: string): void;
  startSubagent(run: SubagentRun, mode: SubagentStartMode): Promise<SubagentRun>;
  adoptCommand(input: AdoptedCommand): Promise<unknown>;
  /** False when no such task is running in this process. */
  stopTask(taskId: string, reason: string): Promise<boolean>;
}

const LIST_LIMIT = 200;

class WorkerTaskService implements TaskPort {
  /** Adoptions past their cap check whose command worker is not registered yet. */
  private pendingCommands = 0;

  constructor(
    private readonly deps: TaskServiceDeps,
    private readonly workers: TaskWorkers
  ) {}

  /**
   * The cap check and the reservation run before the first await, so concurrent
   * adoptions cannot all pass a count that none of them has yet raised.
   */
  async adopt(input: Parameters<CommandHandoff['adopt']>[0]): ReturnType<CommandHandoff['adopt']> {
    const context = input.context;
    if (!isAgentContext(context)) throw new AppError('invalid_context', 'Background commands need a conversation context', 500);
    const { maxCommandTasks } = this.deps;
    if (this.workers.runningCommandCount() + this.pendingCommands >= maxCommandTasks) {
      throw new AppError('too_many_tasks', `At most ${maxCommandTasks} background commands can run at once`, 429);
    }
    this.pendingCommands += 1;
    try {
      return await this.adoptCommandTask(input, context);
    } finally {
      this.pendingCommands -= 1;
    }
  }

  private async adoptCommandTask(
    input: Parameters<CommandHandoff['adopt']>[0],
    context: AgentToolContext
  ): ReturnType<CommandHandoff['adopt']> {
    const taskId = prefixedId('task');
    const outputPath = `${DATA_SUBDIRS.tasks}/${taskId}.log`;
    await this.deps.storage.tasks.create({
      id: taskId,
      conversationId: context.conversationId,
      kind: 'command',
      status: 'running',
      title: input.description,
      prompt: null,
      subagentType: null,
      command: input.command,
      cwd: input.cwd,
      outputPath,
      needsInput: false,
      originMode: context.mode,
      originTurnId: context.turnId,
      originToolCallId: context.toolCallId,
      parentTaskId: context.taskId,
      resumedFromTaskId: null,
      depth: context.taskDepth,
      model: null,
      startedAt: this.iso(),
    });
    this.publishRunning(context.conversationId, taskId, input.description, 'command');
    await this.workers.adoptCommand({
      taskId,
      conversationId: context.conversationId,
      process: input.process,
      outputPath,
      command: input.command,
    });
    return { taskId, outputPath };
  }

  async startSubagent(spec: SubagentSpec): Promise<{ taskId: string }> {
    const run = await this.spawnSubagent(spec, 'background');
    return { taskId: run.taskId };
  }

  async runSubagent(spec: SubagentSpec, signal: AbortSignal): Promise<{ taskId: string; report: string; status: ConversationTask['status'] }> {
    const run = await this.spawnSubagent(spec, 'synchronous', signal);
    const { task } = await run.outcome;
    return { taskId: run.taskId, report: task.report ?? '', status: task.status };
  }

  async list(conversationId: string): Promise<ConversationTask[]> {
    const tasks = await this.deps.storage.tasks.listByConversation(conversationId, { limit: LIST_LIMIT });
    return tasks.map(project);
  }

  async get(conversationId: string, taskId: string): Promise<ConversationTask | null> {
    const task = await this.deps.storage.tasks.get(taskId);
    if (!task || task.conversationId !== conversationId) return null;
    return project(task);
  }

  async stop(conversationId: string, taskId: string): Promise<boolean> {
    const task = await this.deps.storage.tasks.get(taskId);
    if (!task || task.conversationId !== conversationId || task.status !== 'running') return false;
    await this.deps.storage.tasks.requestStop(taskId, this.iso());
    return this.workers.stopTask(taskId, 'Stopped by request');
  }

  /**
   * Registers the worker before any await (the limit check and the registration run
   * synchronously, so concurrent starts cannot both pass), then creates the task row and
   * starts the worker. Archive and stop reach the worker from registration on, even while
   * the row is being written or the loop is spawning.
   */
  private async spawnSubagent(spec: SubagentSpec, mode: SubagentStartMode, signal?: AbortSignal): Promise<SubagentRun> {
    const { maxSubagents } = this.deps;
    if (this.workers.runningSubagentCount() >= maxSubagents) {
      throw new AppError('too_many_tasks', `At most ${maxSubagents} subagents can run at once`, 429);
    }
    const taskId = prefixedId('task');
    const run = this.workers.registerSubagent(taskId, spec);
    // Cancellation reaches the worker from registration on, so an abort during spawning stops
    // it without waiting for start() to return. The listener is released when the run settles.
    const cancel = () => void run.stop('Cancelled by the user');
    const release = () => signal?.removeEventListener('abort', cancel);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    try {
      await this.createSubagentTask(taskId, spec);
    } catch (error) {
      release();
      this.workers.forgetSubagent(taskId);
      throw error;
    }
    void run.outcome.then(release, release);
    return this.workers.startSubagent(run, mode);
  }

  /** Validates a subagent start and creates its running task row. */
  private async createSubagentTask(taskId: string, spec: SubagentSpec): Promise<void> {
    const { storage, subagents } = this.deps;
    if (!subagents.some((definition) => definition.name === spec.subagentType)) {
      throw new AppError('unknown_subagent', `Unknown subagent type "${spec.subagentType}"`, 400);
    }
    if (spec.resumedFromTaskId) {
      const previous = await storage.tasks.get(spec.resumedFromTaskId);
      if (!previous || previous.conversationId !== spec.conversationId || previous.kind !== 'agent') {
        throw new NotFoundError(`Task ${spec.resumedFromTaskId}`);
      }
      if (previous.status === 'running') {
        throw new AppError('task_running', `Task ${spec.resumedFromTaskId} is still running and cannot be resumed`, 409);
      }
    }
    await storage.tasks.create({
      id: taskId,
      conversationId: spec.conversationId,
      kind: 'agent',
      status: 'running',
      title: spec.title,
      prompt: spec.prompt,
      subagentType: spec.subagentType,
      command: null,
      cwd: null,
      outputPath: null,
      needsInput: false,
      originMode: spec.originMode,
      originTurnId: spec.originTurnId,
      originToolCallId: spec.originToolCallId,
      parentTaskId: spec.parentTaskId,
      resumedFromTaskId: spec.resumedFromTaskId,
      depth: spec.depth,
      model: null,
      startedAt: this.iso(),
    });
    this.publishRunning(spec.conversationId, taskId, spec.title, 'agent');
  }

  private publishRunning(conversationId: string, taskId: string, title: string, kind: 'agent' | 'command'): void {
    this.deps.hub.publish(conversationId, { type: 'task', taskId, status: 'running', title, kind });
  }

  private iso(): string {
    return isoAt(this.deps.clock.now());
  }
}

/** The task service over the given storage, hub and workers. */
export function createTaskService(deps: TaskServiceDeps, workers: TaskWorkers): TaskPort {
  return new WorkerTaskService(deps, workers);
}

function isAgentContext(context: unknown): context is AgentToolContext {
  return typeof context === 'object' && context !== null && 'calls' in context && 'tasks' in context && 'mode' in context;
}

/** Projection of a task row for the API and the tools. */
function project(task: TaskRecord): ConversationTask {
  const durationMs = task.endedAt ? Math.max(0, Date.parse(task.endedAt) - Date.parse(task.startedAt)) : undefined;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    kind: task.kind,
    ...(task.report !== null ? { report: task.report } : {}),
    ...(task.command ? { command: task.command } : {}),
    ...(task.stdoutTail ? { stdout: task.stdoutTail } : {}),
    ...(task.stderrTail ? { stderr: task.stderrTail } : {}),
    ...(task.prompt ? { prompt: task.prompt } : {}),
    ...(task.exitCode !== null ? { exitCode: task.exitCode } : {}),
    ...(task.subagentType ? { subagentType: task.subagentType } : {}),
    ...(task.outputPath ? { outputPath: task.outputPath } : {}),
    ...(task.originToolCallId ? { toolCallId: task.originToolCallId } : {}),
    ...(task.resumedFromTaskId ? { resumedFromTaskId: task.resumedFromTaskId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    needsInput: task.needsInput,
    startedAt: task.startedAt,
    ...(task.endedAt ? { endedAt: task.endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}
