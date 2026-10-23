import { AgentLoop, type LoopOutcome } from '@artemis/agent';
import { AppError, uuid } from '@artemis/core';
import type { LlmMessage, ToolDefinition, ToolUseBlock } from '@artemis/llm';
import { mcpToolsSection } from '@artemis/mcp';
import type { TurnUsage } from '@artemis/storage';
import { needsUserInput } from '../subagents/definitions.ts';
import type { AgentToolContext } from '../tools/index.ts';
import { workspaceAccess, type WorkerEnv } from './env.ts';
import { drainLoop, LoopPersistence } from './loop-persistence.ts';
import { TaskWorker } from './task-worker.ts';
import type { SubagentSpec, TaskOutcome } from './types.ts';
import { isoAt, messageOf, toLlmMessages } from './util.ts';

/** Longest chain of resumed tasks replayed into one transcript. */
const MAX_RESUME_CHAIN = 20;

/**
 * A subagent run: AgentLoop on the `worker` route, its own transcript
 * (`messages.task_id = taskId`; a resumed task first replays the transcripts of
 * the tasks it follows), its own frozen prompt snapshot (definition + worker
 * rules + MCP tool list), the full toolset under the `synchronous` policy.
 * Report = final assistant text; `NEEDS USER INPUT:` sets `needsInput`.
 * Streams nothing to the conversation except the task status events.
 */
export class SubagentTaskWorker extends TaskWorker {
  readonly kind = 'subagent-task' as const;
  private readonly controller = new AbortController();
  private stopReason: string | null = null;
  private systemPrompt = '';
  private toolDefinitions: ToolDefinition[] = [];
  private history: LlmMessage[] = [];

  constructor(
    readonly taskId: string,
    readonly spec: SubagentSpec,
    private readonly env: WorkerEnv
  ) {
    super(env.clock);
  }

  get conversationId(): string {
    return this.spec.conversationId;
  }

  /**
   * Freezes the prompt and loads the replayed history, then starts the loop in the background.
   * The worker stays `spawning` until these awaits finish. A stop requested meanwhile is
   * checked after each await: the loop then never starts and `run` persists the task as cancelled.
   */
  async start(): Promise<void> {
    const { env, spec, taskId, controller } = this;
    const definition = env.subagents.find((candidate) => candidate.name === spec.subagentType);
    if (!definition) throw new AppError('unknown_subagent', `Unknown subagent "${spec.subagentType}"`, 400);
    const rendered = await env.prompts.subagent({
      definition: definition.instructions,
      name: definition.name,
      workspace: env.workspace.displayRoot,
      conversationId: spec.conversationId,
      taskId,
      mcpTools: mcpToolsSection(await env.catalog.tools()),
    });
    if (!controller.signal.aborted) {
      this.toolDefinitions = env.tools().definitions();
      this.systemPrompt = rendered.systemPrompt;
      await env.storage.promptSnapshots.create({
        ownerKind: 'task',
        ownerId: taskId,
        systemPrompt: rendered.systemPrompt,
        tools: this.toolDefinitions as unknown[],
        templateId: rendered.templateId,
        templateHash: rendered.templateHash,
      });
    }
    if (!controller.signal.aborted) this.history = await this.resumedHistory();
    this.currentState = 'busy';
    this.touch();
    void this.run().then((outcome) => this.settle(outcome));
  }

  async stop(reason: string): Promise<void> {
    this.stopReason ??= reason;
    this.controller.abort();
  }

  /** A worker still spawning settles by itself once its start resolves; dispose does not wait for that. */
  async dispose(reason: string): Promise<void> {
    if (this.currentState === 'stopped') return;
    await this.stop(reason);
    if (this.currentState !== 'spawning') await this.outcome;
  }

  /** Never rejects: failures are persisted as a failed task. An aborted signal never starts the loop. */
  private async run(): Promise<TaskOutcome> {
    const { env, spec, taskId, controller } = this;
    const route = env.router.route('worker');
    const signal = controller.signal;
    let outcome: LoopOutcome | undefined;
    let failure: string | null = null;
    try {
      if (!signal.aborted) {
        await env.storage.messages.append({
          id: uuid(),
          conversationId: spec.conversationId,
          taskId,
          turnId: null,
          role: 'user',
          content: [{ type: 'text', text: spec.prompt }],
          envelope: null,
          provider: null,
          model: null,
          providerMessageId: null,
          stopReason: null,
          usage: null,
          timings: null,
        });
        const persistence = new LoopPersistence({
          scope: { conversationId: spec.conversationId, taskId, turnId: null, provider: route.provider.id },
          storage: env.storage,
          clock: env.clock,
          signal,
        });
        const events = new AgentLoop().run({
          route,
          system: this.systemPrompt,
          toolDefinitions: this.toolDefinitions,
          toolset: env.tools(),
          messages: [...this.history, { role: 'user', content: [{ type: 'text', text: spec.prompt }] }],
          toolContext: (call: ToolUseBlock) => this.toolContext(call),
          signal,
          newMessageId: () => uuid(),
        });
        outcome = await drainLoop(events, (event) => persistence.handle(event));
      }
    } catch (error) {
      failure = messageOf(error);
      controller.abort();
    }

    const status = failure !== null || outcome?.status === 'failed' || outcome?.status === 'max_steps'
      ? 'failed'
      : outcome?.status === 'cancelled' || signal.aborted
        ? 'cancelled'
        : 'completed';
    const report = this.reportOf(status, failure, outcome);
    const needsInput = status === 'completed' && needsUserInput(report);
    const usage: TurnUsage | null = outcome ? { ...outcome.usage, cacheReadTokens: outcome.usage.cacheReadTokens ?? 0, cacheWriteTokens: outcome.usage.cacheWriteTokens ?? 0, reasoningTokens: outcome.usage.reasoningTokens ?? 0 } : null;
    const finished = await env.storage.tasks.finish(taskId, {
      status,
      report,
      needsInput,
      exitCode: null,
      stdoutTail: null,
      stderrTail: null,
      usage,
      endedAt: isoAt(env.clock.now()),
    });
    const task = finished ?? (await env.storage.tasks.get(taskId));
    if (!task) throw new Error(`Task ${taskId} disappeared`);
    return { task };
  }

  private reportOf(status: 'completed' | 'failed' | 'cancelled', failure: string | null, outcome: LoopOutcome | undefined): string {
    if (status === 'completed') return outcome?.text.trim() || 'The subagent finished without a report.';
    if (status === 'cancelled') return outcome?.text.trim() || this.stopReason || 'Stopped.';
    return failure ?? outcome?.error ?? (outcome?.status === 'max_steps' ? 'The subagent reached its step limit.' : 'The subagent failed.');
  }

  private toolContext(call: ToolUseBlock): AgentToolContext {
    const { env, spec, taskId } = this;
    return {
      conversationId: spec.conversationId,
      taskId,
      turnId: null,
      toolCallId: call.id,
      signal: this.controller.signal,
      policy: 'synchronous',
      workspace: env.workspace,
      access: workspaceAccess(env.config),
      logger: env.logger,
      mode: spec.originMode,
      taskDepth: spec.depth,
      tasks: env.tasks(),
      calls: env.calls,
    };
  }

  /** Transcripts of the tasks this one resumes, oldest first. */
  private async resumedHistory(): Promise<LlmMessage[]> {
    const chain: string[] = [];
    let id = this.spec.resumedFromTaskId;
    while (id && chain.length < MAX_RESUME_CHAIN) {
      chain.unshift(id);
      id = (await this.env.storage.tasks.get(id))?.resumedFromTaskId ?? null;
    }
    const history: LlmMessage[] = [];
    for (const taskId of chain) {
      history.push(...toLlmMessages(await this.env.storage.messages.transcript(this.spec.conversationId, taskId)));
    }
    return history;
  }
}
