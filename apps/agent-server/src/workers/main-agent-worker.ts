import type { LoopOutcome } from '@artemis/agent-loop';
import { AppError, errorMessage, NotFoundError, uuid } from '@artemis/core';
import type { ImageBlock, LlmMessage, ToolUseBlock, UserContent } from '@artemis/llm';
import type { ConversationRecord, RecalledMemory } from '@artemis/storage';
import { CallStateFilter } from '../calls/call-state-filter.ts';
import { depthAfter } from '../tasks/policy.ts';
import type { AgentToolContext } from '../tools/index.ts';
import { formatCurrentDateTime, renderUserTurn } from './main-agent/render.ts';
import { snapshotToolDefinitions, toLlmMessages } from './main-agent/codecs.ts';
import { workspaceAccess, type WorkerEnv } from './env.ts';
import { LoopPersistence, runLoop } from './main-agent/loop-persistence.ts';
import { claimUpdates } from './main-agent/claims.ts';
import { inlineImages, userEnvelope } from './main-agent/envelope.ts';
import { turnError, turnStatus, turnUsage } from './main-agent/outcome.ts';
import type { TurnState } from './main-agent/turn-state.ts';
import { McpReminder } from './main-agent/mcp-reminder.ts';
import { SerialScheduler } from './scheduler.ts';
import { TurnFollowups } from './main-agent/turn-followups.ts';
import { type TurnResult, TurnPersistence } from './main-agent/turn-persistence.ts';
import type { TurnHandle, TurnOutcome, TurnSubmission } from '../turns/types.ts';
import { Worker } from './worker.ts';

/** What a turn's model run produced: the loop outcome and, for voice turns, the call state. */
interface ModelRun {
  outcome: LoopOutcome;
  callState?: 'listen' | 'done' | null;
}

/**
 * The ports the main agent's turns run on. The supervisor passes its full
 * `WorkerEnv`; the persistence, follow-up and reminder collaborators are built
 * from this same object.
 */
export type MainAgentEnv = Pick<
  WorkerEnv,
  'config' | 'storage' | 'router' | 'hub' | 'calls' | 'workspace' | 'clock' | 'logger' | 'delivery' | 'tasks' | 'tools' | 'memory' | 'titles' | 'catalog'
>;

/**
 * The generating loop of one conversation. Spawned lazily by the supervisor on
 * the first need (message, warm-up, waking update), reaped after
 * `idleTimeoutMs` without activity; a running turn, queued turns, an active call
 * or any running task of the conversation count as activity.
 *
 * Turns are serialized by a `SerialScheduler` (pending limit -> `BusyError`).
 * One turn (see docs/architecture.md#conversations-memory-and-background-work):
 *  1. open the turn (running), publish `turn_start`, memory activation;
 *  2. claim held updates (text turns) or take the voice update's claim;
 *  3. in parallel: memory recall, MCP reminder plan, inline image attachments;
 *  4. render + persist the user message; publish its echo and the update rows;
 *  5. the loop on the turn's route; every loop event is persisted and published;
 *  6. finish: turn status/usage, deliveries complete or roll back, `context_usage`,
 *     `turn_end`, memory `turnCompleted`, title request on the first user message,
 *     and the MCP tool snapshot when the turn completed.
 * Persistence (`TurnPersistence`), memory and titles (`TurnFollowups`) and the MCP
 * reminder (`McpReminder`) are collaborators; this class runs the loop between them.
 */
export class MainAgentWorker extends Worker {
  readonly kind = 'main-agent' as const;
  private readonly scheduler: SerialScheduler;
  private readonly persistence: TurnPersistence;
  private readonly followups: TurnFollowups;
  private readonly mcp: McpReminder;
  private active: { turnId: string; controller: AbortController } | null = null;

  constructor(
    readonly conversationId: string,
    private readonly env: MainAgentEnv,
    /** True while a task of this conversation runs (keeps the worker alive). */
    private readonly tasksRunning: (conversationId: string) => boolean
  ) {
    super(env.clock);
    this.scheduler = new SerialScheduler(env.config.workers.maxPendingTurns);
    this.persistence = new TurnPersistence(env);
    this.followups = new TurnFollowups(env);
    this.mcp = new McpReminder(env);
  }

  get id(): string {
    return this.conversationId;
  }

  /** Loads the conversation; throws `NotFoundError` for unknown or archived conversations. */
  async start(): Promise<void> {
    const conversation = await this.env.storage.conversations.get(this.conversationId);
    if (!conversation) throw new NotFoundError(`Conversation ${this.conversationId}`);
    this.currentState = 'idle';
    this.touch();
  }

  /** Queue a turn; throws `BusyError` when the queue is full. */
  submit(submission: TurnSubmission): TurnHandle {
    if (this.currentState === 'stopping' || this.currentState === 'stopped') {
      throw new AppError('worker_stopped', 'The conversation is shutting down its agent; retry', 409);
    }
    const turnId = uuid();
    const done = this.scheduler.enqueue(() => this.runTurn(turnId, submission));
    this.touch();
    return { turnId, done };
  }

  /** Abort the running turn (queued turns stay). */
  cancel(): boolean {
    if (!this.active) return false;
    this.active.controller.abort();
    return true;
  }

  get busy(): boolean {
    return this.scheduler.pending > 0;
  }

  /** Records activity from outside (task start/end, call open/close). */
  markActivity(): void {
    this.touch();
  }

  isActive(_now: number): boolean {
    if (this.currentState === 'stopped' || this.currentState === 'failed') return false;
    return this.busy || this.tasksRunning(this.conversationId) || this.env.calls.active(this.conversationId) !== null;
  }

  async dispose(_reason: string): Promise<void> {
    if (this.currentState === 'stopped') return;
    this.currentState = 'stopping';
    this.active?.controller.abort();
    await this.scheduler.drain();
    this.currentState = 'stopped';
  }

  private async runTurn(turnId: string, submission: TurnSubmission): Promise<TurnOutcome> {
    if (this.currentState === 'stopping' || this.currentState === 'stopped') {
      return { turnId, status: 'cancelled', text: '', error: 'The agent is shutting down' };
    }
    const controller = new AbortController();
    const signal = submission.signal ? AbortSignal.any([controller.signal, submission.signal]) : controller.signal;
    const state: TurnState = { turnId, submission, signal, controller, token: null, claimed: [], recorded: false, finished: false };
    this.active = { turnId, controller };
    this.currentState = 'busy';
    this.touch();
    try {
      return await this.execute(state);
    } catch (error) {
      return this.abandon(state, error);
    } finally {
      this.active = null;
      if (this.currentState === 'busy') this.currentState = 'idle';
      this.touch();
    }
  }

  /** The steps of one turn, in order (see the class comment). */
  private async execute(state: TurnState): Promise<TurnOutcome> {
    const { conversationId } = this;
    await this.openTurn(state);
    const { conversation, snapshot } = await this.loadTurnContext();
    await claimUpdates(state, conversationId, this.env.delivery);
    const history = toLlmMessages(await this.env.storage.messages.transcript(conversationId, null));
    const [memories, mcp, images] = await Promise.all([
      this.followups.recall(conversationId, state),
      this.mcp.plan(conversationId, conversation, state.signal),
      inlineImages(this.env.workspace, this.env.logger, state.submission.attachments ?? []),
    ]);
    const content = await this.persistUserMessage(state, memories, mcp.reminder, images);
    const run = await this.runModel(state, snapshot, [...history, { role: 'user', content }]);
    const outcome = await this.complete(state, run);
    if (outcome.status === 'completed' && mcp.names) await this.mcp.remember(conversationId, mcp.names);
    return outcome;
  }

  /** Persists the running turn row, publishes its start, and activates memory for the conversation. */
  private async openTurn(state: TurnState): Promise<void> {
    await this.persistence.open(state, this.conversationId);
    await this.followups.activate(this.conversationId);
  }

  /** The conversation and its frozen prompt snapshot; both must exist for a turn. */
  private async loadTurnContext(): Promise<{
    conversation: ConversationRecord;
    snapshot: { systemPrompt: string; tools: readonly unknown[] };
  }> {
    const { env, conversationId } = this;
    const conversation = await env.storage.conversations.get(conversationId);
    if (!conversation) throw new NotFoundError(`Conversation ${conversationId}`);
    const snapshot = await env.storage.promptSnapshots.getForOwner('conversation', conversationId);
    if (!snapshot) throw new AppError('snapshot_missing', `Conversation ${conversationId} has no prompt snapshot`, 500);
    return { conversation, snapshot };
  }

  /** Renders the envelope and stores the user message verbatim (with its echo). */
  private async persistUserMessage(
    state: TurnState,
    memories: RecalledMemory[],
    mcpReminder: string | undefined,
    images: ImageBlock[]
  ): Promise<UserContent[]> {
    const { env, conversationId } = this;
    const envelope = userEnvelope({
      submission: state.submission,
      claimed: state.claimed,
      memories,
      mcpReminder,
      currentDateTime: formatCurrentDateTime(env.clock.now(), env.config.assistant.timezone),
    });
    const content: UserContent[] = renderUserTurn(envelope, images);
    await this.persistence.appendUserMessage(state, conversationId, envelope, content);
    return content;
  }

  /** Runs the loop on the turn's route; voice text goes to the call filter and the spoken-text sink. */
  private async runModel(state: TurnState, snapshot: { systemPrompt: string; tools: readonly unknown[] }, messages: LlmMessage[]): Promise<ModelRun> {
    const { env, conversationId } = this;
    const { turnId, submission: sub, signal } = state;
    const voice = sub.modality === 'voice';
    const route = env.router.route(sub.kind === 'update' ? 'update' : voice ? 'assistant-voice' : 'assistant-text', {
      effort: sub.effort,
      modality: sub.modality,
    });
    const filter = new CallStateFilter();
    const persistence = new LoopPersistence({
      scope: { conversationId, taskId: null, turnId, provider: route.provider.id },
      storage: env.storage,
      clock: env.clock,
      signal,
      publish: (event) => env.hub.publish(conversationId, event),
      ...(voice ? { voice: { filter, onText: sub.onText } } : {}),
    });
    let outcome: LoopOutcome;
    try {
      outcome = await runLoop(
        {
          route,
          system: snapshot.systemPrompt,
          toolDefinitions: snapshotToolDefinitions(snapshot.tools, `conversation ${conversationId}`),
          toolset: env.tools,
          messages,
          toolContext: (call: ToolUseBlock) => this.toolContext(state, depthAfter(state.claimed), call),
          signal,
        },
        persistence
      );
    } catch (error) {
      state.controller.abort();
      throw error;
    }
    return { outcome, ...(voice ? { callState: filter.state } : {}) };
  }

  /** Persists the turn's result and returns the outcome to the caller. */
  private async complete(state: TurnState, run: ModelRun): Promise<TurnOutcome> {
    const { turnId, submission: sub } = state;
    const { outcome } = run;
    const status = turnStatus(outcome);
    const error = turnError(outcome, status);
    await this.finish(state, { status, error, usage: turnUsage(outcome.usage), model: outcome.model });
    return { turnId, status, text: outcome.text, ...(error ? { error } : {}), ...(sub.modality === 'voice' ? { callState: run.callState } : {}) };
  }

  /** Ends the turn: persisted status and end events, then the memory and title follow-ups. */
  private async finish(state: TurnState, result: TurnResult): Promise<void> {
    await this.persistence.finish(state, this.conversationId, result);
    await this.followups.completed(this.conversationId, state.turnId, state.submission);
  }

  /** A turn that threw: its row is failed, its claim rolled back, and the failure returned as the outcome. */
  private async abandon(state: TurnState, error: unknown): Promise<TurnOutcome> {
    const { env, conversationId } = this;
    const { turnId } = state;
    const message = errorMessage(error);
    env.logger.error('turn failed', { conversationId, turnId, error: message });
    await this.persistence.abandon(state, conversationId, message);
    return { turnId, status: 'failed', text: '', error: message };
  }

  private toolContext(state: TurnState, taskDepth: number, call: ToolUseBlock): AgentToolContext {
    const { env, conversationId } = this;
    return {
      conversationId,
      taskId: null,
      turnId: state.turnId,
      toolCallId: call.id,
      signal: state.signal,
      policy: 'interactive',
      workspace: env.workspace,
      access: workspaceAccess(env.config),
      logger: env.logger,
      mode: state.submission.mode,
      effort: state.submission.effort ?? null,
      taskDepth,
      tasks: env.tasks,
      calls: env.calls,
    };
  }
}
