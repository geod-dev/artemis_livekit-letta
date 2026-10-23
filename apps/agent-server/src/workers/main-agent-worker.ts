import type { LoopOutcome } from '@artemis/agent-loop';
import { AppError, BusyError, errorMessage, NotFoundError, uuid } from '@artemis/core';
import type { ChatMessage } from '@artemis/contracts/chat-types';
import type { ImageBlock, LlmMessage, ToolUseBlock, UserContent } from '@artemis/llm';
import { mcpToolsReminder } from '@artemis/mcp';
import type { ConversationRecord, RecalledMemory, TurnRecord, TurnUsage } from '@artemis/storage';
import { CallStateFilter } from '../calls/call-state-filter.ts';
import { depthAfter } from '../tasks/policy.ts';
import type { AgentToolContext } from '../tools/index.ts';
import { formatCurrentDateTime, renderUserTurn } from '../turns/render.ts';
import { snapshotToolDefinitions, toLlmMessages } from './codecs.ts';
import { workspaceAccess, type WorkerEnv } from './env.ts';
import { LoopPersistence, runLoop } from './loop-persistence.ts';
import { claimUpdates, settleClaim } from './main-agent/claims.ts';
import { echoRows, inlineImages, updateQuery, userEnvelope } from './main-agent/envelope.ts';
import { turnError, turnStatus, turnUsage, type TurnStatus } from './main-agent/outcome.ts';
import type { TurnState } from './main-agent/turn-state.ts';
import { SerialScheduler } from './scheduler.ts';
import { safely } from './safely.ts';
import type { TurnHandle, TurnOutcome, TurnSubmission } from './types.ts';
import { Worker } from './worker.ts';
import { isoAt } from '../util/time.ts';

/** What a turn's model run produced: the loop outcome and, for voice turns, the call state. */
interface ModelRun {
  outcome: LoopOutcome;
  callState?: 'listen' | 'done' | null;
}

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
 *  3. in parallel: memory recall, MCP reminder diff, inline image attachments;
 *  4. render + persist the user message; publish its echo and the update rows;
 *  5. the loop on the turn's route; every loop event is persisted and published;
 *  6. finish: turn status/usage, deliveries complete or roll back, `context_usage`,
 *     `turn_end`, memory `turnCompleted`, title request on the first user message.
 */
export class MainAgentWorker extends Worker {
  readonly kind = 'main-agent' as const;
  private readonly scheduler: SerialScheduler;
  private active: { turnId: string; controller: AbortController } | null = null;

  constructor(
    readonly conversationId: string,
    private readonly env: WorkerEnv,
    /** True while a task of this conversation runs (keeps the worker alive). */
    private readonly tasksRunning: (conversationId: string) => boolean
  ) {
    super(env.clock);
    this.scheduler = new SerialScheduler(env.config.workers.maxPendingTurns);
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
    if (this.scheduler.pending >= this.env.config.workers.maxPendingTurns) throw new BusyError();
    const turnId = uuid();
    this.touch();
    const done = this.scheduler.run(() => this.runTurn(turnId, submission));
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
      this.recall(state),
      this.mcpReminder(conversation),
      inlineImages(this.env.workspace, this.env.logger, state.submission.attachments ?? []),
    ]);
    const content = await this.persistUserMessage(state, memories, mcp.reminder, images);
    const run = await this.runModel(state, snapshot, [...history, { role: 'user', content }]);
    return this.complete(state, run);
  }

  /** Persists the running turn row, publishes its start, and activates memory for the conversation. */
  private async openTurn(state: TurnState): Promise<void> {
    const { env, conversationId } = this;
    const { turnId, submission: sub } = state;
    const started = await env.storage.turns.create({
      id: turnId,
      conversationId,
      kind: sub.kind,
      modality: sub.modality,
      mode: sub.mode,
      effort: sub.effort ?? null,
      status: 'running',
      clientMessageId: sub.clientMessageId ?? null,
      model: null,
      startedAt: this.iso(),
    });
    state.recorded = true;
    env.hub.publish(conversationId, { type: 'turn_start', turnId, modality: sub.modality });
    await env.storage.conversations.touch(conversationId, started.startedAt);
    await safely(env.logger, 'memory activation', () => env.memory.conversationActivated(conversationId));
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

  /** Renders the envelope, stores the user message verbatim, and publishes its live rows. */
  private async persistUserMessage(
    state: TurnState,
    memories: RecalledMemory[],
    mcpReminder: string | undefined,
    images: ImageBlock[]
  ): Promise<UserContent[]> {
    const { env, conversationId } = this;
    const { turnId, submission: sub } = state;
    const envelope = userEnvelope({
      submission: sub,
      claimed: state.claimed,
      memories,
      mcpReminder,
      currentDateTime: formatCurrentDateTime(env.clock.now(), env.config.assistant.timezone),
    });
    const content: UserContent[] = renderUserTurn(envelope, images);
    const userMessage = await env.storage.messages.append({
      id: uuid(),
      conversationId,
      taskId: null,
      turnId,
      role: 'user',
      content,
      envelope,
      provider: null,
      model: null,
      providerMessageId: null,
      stopReason: null,
      usage: null,
      timings: null,
    });
    this.echo(state, userMessage.id, userMessage.createdAt);
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

  /** Ends the turn: persisted status, delivery settlement, live end events, memory and title follow-ups. */
  private async finish(state: TurnState, result: { status: TurnStatus; error?: string; usage: TurnUsage; model: string }): Promise<void> {
    const { env, conversationId } = this;
    const { turnId, submission: sub } = state;
    await env.storage.turns.finish(turnId, {
      status: result.status,
      error: result.error ?? null,
      usage: result.usage,
      model: result.model,
      endedAt: this.iso(),
    });
    state.finished = true;
    await settleClaim(state, conversationId, env.delivery, result.status === 'completed');
    env.hub.publish(conversationId, { type: 'context_usage' });
    env.hub.publish(conversationId, {
      type: 'turn_end',
      turnId,
      success: result.status === 'completed',
      ...(result.error ? { error: result.error } : {}),
    });
    const record: TurnRecord | null = await env.storage.turns.get(turnId);
    if (record) await safely(env.logger, 'memory turn bookkeeping', () => env.memory.turnCompleted(record));
    const conversation = await env.storage.conversations.get(conversationId);
    if (sub.kind === 'user' && conversation && !conversation.title && sub.text.trim()) env.titles.request(conversationId, sub.text);
  }

  /** A turn that threw: its row is failed, its claim rolled back, and the failure returned as the outcome. */
  private async abandon(state: TurnState, error: unknown): Promise<TurnOutcome> {
    const { env, conversationId } = this;
    const { turnId } = state;
    const message = errorMessage(error);
    env.logger.error('turn failed', { conversationId, turnId, error: message });
    if (state.recorded && !state.finished) {
      await safely(env.logger, 'turn failure record', () =>
        env.storage.turns.finish(turnId, { status: 'failed', error: message, usage: null, model: null, endedAt: this.iso() })
      );
      state.finished = true;
      env.hub.publish(conversationId, { type: 'turn_end', turnId, success: false, error: message });
    }
    await safely(env.logger, 'delivery rollback', () => settleClaim(state, conversationId, env.delivery, false));
    return { turnId, status: 'failed', text: '', error: message };
  }

  /** Live rows of this turn: the updates it delivers and the user's message. */
  private echo(state: TurnState, messageId: string, createdAt: string): void {
    const rows: ChatMessage[] = echoRows(state, messageId, createdAt);
    for (const row of rows) this.env.hub.publish(this.conversationId, { type: 'message', turnId: state.turnId, message: row });
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

  /**
   * Recall before every answer (user, voice and update turns). The coordinator
   * applies its timeout, dedups against the conversation and writes the trace;
   * a failure here still means no memories, never a failed turn.
   */
  private async recall(state: TurnState): Promise<RecalledMemory[]> {
    const sub = state.submission;
    const query = sub.kind === 'update' ? updateQuery(state.claimed) : sub.text;
    try {
      return await this.env.memory.recallFor({
        conversationId: this.conversationId,
        turnId: state.turnId,
        modality: sub.modality,
        effort: sub.effort ?? null,
        query,
        signal: state.signal,
      });
    } catch (error) {
      this.env.logger.warn('recall skipped', { turnId: state.turnId, error: errorMessage(error) });
      return [];
    }
  }

  /** MCP tools added or removed since the conversation last saw them. */
  private async mcpReminder(conversation: ConversationRecord): Promise<{ reminder?: string }> {
    try {
      const names = await this.env.catalog.names();
      const reminder = mcpToolsReminder(names, conversation.mcpToolNamesShown);
      await this.env.storage.conversations.setMcpToolNamesShown(this.conversationId, names);
      return reminder ? { reminder } : {};
    } catch (error) {
      this.env.logger.warn('MCP tool list unavailable for this turn', { conversationId: this.conversationId, error: errorMessage(error) });
      return {};
    }
  }

  private iso(): string {
    return isoAt(this.env.clock.now());
  }
}
