import { AppError, NotFoundError, prefixedId } from '@artemis/core';
import type { ConversationTask } from '@artemis/contracts/chat-types';
import type { TaskRecord } from '@artemis/storage';
import type { CommandHandoff } from '@artemis/tools/workspace-tools';
import type { WorkerEnv } from '../workers/env.ts';
import type { SubagentTaskWorker } from '../workers/subagent-task-worker.ts';
import type { WorkerSupervisor } from '../workers/supervisor.ts';
import type { SubagentSpec, SubagentStartMode } from '../workers/types.ts';
import type { AgentToolContext } from '../tools/index.ts';
import { isoAt } from '../workers/util.ts';

/**
 * Task lifecycle facade used by tools and the API. Creates `tasks` rows,
 * asks the supervisor for workers, publishes `task` SSE events, and projects
 * `TaskRecord` -> `ConversationTask`. Implements the bash `CommandHandoff`.
 */
export abstract class TaskService implements CommandHandoff {
  abstract adopt(input: Parameters<CommandHandoff['adopt']>[0]): ReturnType<CommandHandoff['adopt']>;

  /** Start a subagent in the background (main agent) -> task id. */
  abstract startSubagent(spec: SubagentSpec): Promise<{ taskId: string }>;

  /** Run a subagent and wait for its report (synchronous policy, nested). */
  abstract runSubagent(spec: SubagentSpec, signal: AbortSignal): Promise<{ taskId: string; report: string; status: ConversationTask['status'] }>;

  abstract list(conversationId: string): Promise<ConversationTask[]>;
  abstract get(conversationId: string, taskId: string): Promise<ConversationTask | null>;
  /** Stop a running task (ends `cancelled`); false if not running. */
  abstract stop(conversationId: string, taskId: string): Promise<boolean>;
}

const LIST_LIMIT = 200;

export class WorkerTaskService extends TaskService {
  constructor(
    private readonly env: WorkerEnv,
    private readonly supervisor: WorkerSupervisor
  ) {
    super();
  }

  async adopt(input: Parameters<CommandHandoff['adopt']>[0]): ReturnType<CommandHandoff['adopt']> {
    const context = input.context;
    if (!isAgentContext(context)) throw new AppError('invalid_context', 'Background commands need a conversation context', 500);
    const taskId = prefixedId('task');
    const outputPath = `data/tasks/${taskId}.log`;
    await this.env.storage.tasks.create({
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
    await this.supervisor.adoptCommand({
      taskId,
      conversationId: context.conversationId,
      process: input.process,
      outputPath,
      command: input.command,
    });
    return { taskId, outputPath };
  }

  async startSubagent(spec: SubagentSpec): Promise<{ taskId: string }> {
    const worker = await this.spawnSubagent(spec, 'background');
    return { taskId: worker.taskId };
  }

  async runSubagent(spec: SubagentSpec, signal: AbortSignal): Promise<{ taskId: string; report: string; status: ConversationTask['status'] }> {
    const worker = await this.spawnSubagent(spec, 'synchronous');
    const { taskId } = worker;
    const stop = () => void worker.stop('Cancelled by the user');
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    try {
      const { task } = await worker.outcome;
      return { taskId, report: task.report ?? '', status: task.status };
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  async list(conversationId: string): Promise<ConversationTask[]> {
    const tasks = await this.env.storage.tasks.listByConversation(conversationId, { limit: LIST_LIMIT });
    return tasks.map(project);
  }

  async get(conversationId: string, taskId: string): Promise<ConversationTask | null> {
    const task = await this.env.storage.tasks.get(taskId);
    if (!task || task.conversationId !== conversationId) return null;
    return project(task);
  }

  async stop(conversationId: string, taskId: string): Promise<boolean> {
    const task = await this.env.storage.tasks.get(taskId);
    if (!task || task.conversationId !== conversationId || task.status !== 'running') return false;
    await this.env.storage.tasks.requestStop(taskId, this.iso());
    return this.supervisor.stopTask(taskId, 'Stopped by request');
  }

  /**
   * Registers the worker before any await (the limit check and the registration run
   * synchronously, so concurrent starts cannot both pass), then creates the task row and
   * starts the worker. Archive and stop reach the worker from registration on, even while
   * the row is being written or the loop is spawning.
   */
  private async spawnSubagent(spec: SubagentSpec, mode: SubagentStartMode): Promise<SubagentTaskWorker> {
    const { maxSubagents } = this.env.config.workers;
    if (this.supervisor.runningSubagentCount() >= maxSubagents) {
      throw new AppError('too_many_tasks', `At most ${maxSubagents} subagents can run at once`, 429);
    }
    const taskId = prefixedId('task');
    const worker = this.supervisor.registerSubagent(taskId, spec);
    try {
      await this.createSubagentTask(taskId, spec);
    } catch (error) {
      this.supervisor.forgetSubagent(taskId);
      throw error;
    }
    return this.supervisor.startSubagent(worker, mode);
  }

  /** Validates a subagent start and creates its running task row. */
  private async createSubagentTask(taskId: string, spec: SubagentSpec): Promise<void> {
    const { storage, subagents } = this.env;
    if (!subagents.some((definition) => definition.name === spec.subagentType)) {
      throw new AppError('unknown_subagent', `Unknown subagent type "${spec.subagentType}"`, 400);
    }
    if (spec.resumedFromTaskId) {
      const previous = await storage.tasks.get(spec.resumedFromTaskId);
      if (!previous || previous.conversationId !== spec.conversationId || previous.kind !== 'agent') {
        throw new NotFoundError(`Task ${spec.resumedFromTaskId}`);
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
    this.env.hub.publish(conversationId, { type: 'task', taskId, status: 'running', title, kind });
  }

  private iso(): string {
    return isoAt(this.env.clock.now());
  }
}

function isAgentContext(context: unknown): context is AgentToolContext {
  return typeof context === 'object' && context !== null && 'calls' in context && 'tasks' in context && 'mode' in context;
}

/** Projection of a task row for the API and the tools. */
export function project(task: TaskRecord): ConversationTask {
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
