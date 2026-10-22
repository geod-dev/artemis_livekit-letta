import { AgentLoop, type LoopOutcome } from '@artemis/agent';
import { AppError, BusyError, NotFoundError, prefixedId, SerialScheduler } from '@artemis/core';
import type { ChatAttachment, ChatMessage } from '@artemis/contracts/chat-types';
import type { ImageBlock, ToolDefinition, ToolUseBlock, UserContent } from '@artemis/llm';
import { mcpToolsReminder } from '@artemis/mcp';
import type {
  BackgroundUpdateRecord,
  ConversationRecord,
  DeliveredUpdate,
  RecalledMemory,
  TurnRecord,
  TurnUsage,
  UserTurnEnvelope,
} from '@artemis/storage';
import { depthAfter } from '../background/policy.ts';
import { updateEventRow } from '../background/delivery.ts';
import { CallStateFilter, formatCurrentDateTime, renderUserTurn } from '../turns/envelope.ts';
import type { AgentToolContext } from '../tools/index.ts';
import { drainLoop, LoopPersistence } from './loop-persistence.ts';
import { workspaceAccess, type WorkerEnv } from './env.ts';
import type { TurnHandle, TurnOutcome, TurnSubmission } from './types.ts';
import { Worker } from './worker.ts';
import { isoAt, messageOf, safely, toLlmMessages } from './util.ts';

const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set<ImageBlock['mediaType']>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Per-turn bookkeeping shared by the steps of one turn. */
interface TurnState {
  turnId: string;
  submission: TurnSubmission;
  signal: AbortSignal;
  controller: AbortController;
  /** Claim of the held / queued updates this turn delivers. */
  token: string | null;
  claimed: BackgroundUpdateRecord[];
  /** The turn row exists (so it must be finished on failure). */
  recorded: boolean;
  finished: boolean;
}

/**
 * The generating loop of one conversation. Spawned lazily by the supervisor on
 * the first need (message, warm-up, waking update), reaped after
 * `idleTimeoutMs` without activity; a running turn, queued turns, an active call
 * or any running task of the conversation count as activity.
 *
 * Turns are serialized by a `SerialScheduler` (pending limit -> `BusyError`).
 * One turn (see architecture.md#turn-loop):
 *  1. persist the turn (running), publish `turn_start`, memory activation;
 *  2. claim held updates (text turns) or take the voice update's claim;
 *  3. in parallel: memory recall, MCP reminder diff, inline image attachments;
 *  4. render + persist the user message; publish its echo and the update rows;
 *  5. AgentLoop with the route for the turn; every loop event is persisted and published;
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
    const turnId = prefixedId('turn');
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

  private async execute(state: TurnState): Promise<TurnOutcome> {
    const { env, conversationId } = this;
    const { turnId, submission: sub, signal } = state;
    const voice = sub.modality === 'voice';

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

    const conversation = await env.storage.conversations.get(conversationId);
    if (!conversation) throw new NotFoundError(`Conversation ${conversationId}`);
    const snapshot = await env.storage.promptSnapshots.getForOwner('conversation', conversationId);
    if (!snapshot) throw new AppError('snapshot_missing', `Conversation ${conversationId} has no prompt snapshot`, 500);

    if (sub.updates) {
      state.claimed = sub.updates;
      state.token = sub.deliveryToken ?? null;
    } else if (sub.modality === 'text') {
      const claim = await env.delivery.claimHeld(conversationId);
      state.claimed = claim.updates;
      state.token = claim.token;
    }

    const history = toLlmMessages(await env.storage.messages.transcript(conversationId, null));
    const [memories, mcp, images] = await Promise.all([
      this.recall(state),
      this.mcpReminder(conversation),
      this.inlineImages(sub.attachments ?? []),
    ]);

    const envelope: UserTurnEnvelope = {
      version: 2,
      mode: sub.mode,
      text: sub.text,
      currentDateTime: formatCurrentDateTime(env.clock.now(), env.config.assistant.timezone),
      attachments: sub.attachments ?? [],
      updates: state.claimed.map(toDeliveredUpdate),
      recalledMemories: memories,
      ...(mcp.reminder ? { mcpReminder: mcp.reminder } : {}),
      ...(sub.clientMessageId ? { clientMessageId: sub.clientMessageId } : {}),
    };
    const content: UserContent[] = renderUserTurn(envelope, images);
    const userMessage = await env.storage.messages.append({
      id: prefixedId('msg'),
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

    const route = env.router.route(sub.kind === 'update' ? 'update' : voice ? 'assistant-voice' : 'assistant-text', {
      effort: sub.effort,
      modality: sub.modality,
    });
    const filter = new CallStateFilter();
    const depth = depthAfter(state.claimed);
    const persistence = new LoopPersistence({
      scope: { conversationId, taskId: null, turnId, provider: route.provider.id },
      storage: env.storage,
      clock: env.clock,
      signal,
      publish: (event) => env.hub.publish(conversationId, event),
      ...(voice ? { voice: { filter, onText: sub.onText } } : {}),
    });

    const events = new AgentLoop().run({
      route,
      system: snapshot.systemPrompt,
      toolDefinitions: snapshot.tools as ToolDefinition[],
      toolset: env.tools(),
      messages: [...history, { role: 'user', content }],
      toolContext: (call: ToolUseBlock) => this.toolContext(state, depth, call),
      signal,
      newMessageId: () => prefixedId('msg'),
    });
    let outcome: LoopOutcome;
    try {
      outcome = await drainLoop(events, (event) => persistence.handle(event));
    } catch (error) {
      state.controller.abort();
      throw error;
    }

    const callState = voice ? filter.state : undefined;
    const status = outcome.status === 'completed' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    const error = status === 'failed' ? (outcome.error ?? (outcome.status === 'max_steps' ? 'The step limit was reached' : 'The turn failed')) : undefined;
    const usage: TurnUsage = {
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      cacheReadTokens: outcome.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: outcome.usage.cacheWriteTokens ?? 0,
      reasoningTokens: outcome.usage.reasoningTokens ?? 0,
      steps: outcome.usage.steps,
      lastContextTokens: outcome.usage.lastContextTokens,
    };
    await this.finish(state, { status, error, usage, model: outcome.model });
    return { turnId, status, text: outcome.text, ...(error ? { error } : {}), ...(voice ? { callState } : {}) };
  }

  /** Ends the turn: persisted status, delivery settlement, live end events, memory and title follow-ups. */
  private async finish(
    state: TurnState,
    result: { status: 'completed' | 'failed' | 'cancelled'; error?: string; usage: TurnUsage; model: string }
  ): Promise<void> {
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
    await this.settle(state, result.status === 'completed');
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

  private async abandon(state: TurnState, error: unknown): Promise<TurnOutcome> {
    const { env, conversationId } = this;
    const { turnId } = state;
    const message = messageOf(error);
    env.logger.error('turn failed', { conversationId, turnId, error: message });
    if (state.recorded && !state.finished) {
      await safely(env.logger, 'turn failure record', () =>
        env.storage.turns.finish(turnId, { status: 'failed', error: message, usage: null, model: null, endedAt: this.iso() })
      );
      state.finished = true;
      env.hub.publish(conversationId, { type: 'turn_end', turnId, success: false, error: message });
    }
    await safely(env.logger, 'delivery rollback', () => this.settle(state, false));
    return { turnId, status: 'failed', text: '', error: message };
  }

  /** Completes (the turn delivered its updates) or rolls back the claimed updates. */
  private async settle(state: TurnState, delivered: boolean): Promise<void> {
    if (!state.token) return;
    const { delivery } = this.env;
    if (delivered) await delivery.complete(this.conversationId, state.token, state.turnId);
    else await delivery.rollback(this.conversationId, state.token);
    state.token = null;
  }

  /** Live rows of this turn: the user's message and the updates it delivers. */
  private echo(state: TurnState, messageId: string, createdAt: string): void {
    const { hub } = this.env;
    const sub = state.submission;
    const rows: ChatMessage[] = state.claimed.map(updateEventRow);
    if (sub.kind === 'user' && (sub.text || (sub.attachments?.length ?? 0) > 0)) {
      rows.push({
        id: messageId,
        role: 'user',
        text: sub.text,
        modality: sub.modality,
        ...(sub.attachments?.length ? { attachments: sub.attachments } : {}),
        createdAt,
        ...(sub.clientMessageId ? { clientMessageId: sub.clientMessageId } : {}),
      });
    }
    for (const row of rows) hub.publish(this.conversationId, { type: 'message', turnId: state.turnId, message: row });
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
      tasks: env.tasks(),
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
      this.env.logger.warn('recall skipped', { turnId: state.turnId, error: messageOf(error) });
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
      this.env.logger.warn('MCP tool list unavailable for this turn', { conversationId: this.conversationId, error: messageOf(error) });
      return {};
    }
  }

  /** Small image attachments, read through the workspace, sent inline to the model. */
  private async inlineImages(attachments: readonly ChatAttachment[]): Promise<ImageBlock[]> {
    const images: ImageBlock[] = [];
    for (const attachment of attachments) {
      const mediaType = attachment.mimeType as ImageBlock['mediaType'] | undefined;
      if (attachment.kind !== 'image' || !mediaType || !INLINE_IMAGE_TYPES.has(mediaType)) continue;
      try {
        const stat = await this.env.workspace.stat(attachment.path);
        if (!stat || stat.size > MAX_INLINE_IMAGE_BYTES) continue;
        const bytes = await this.env.workspace.readFile(attachment.path);
        images.push({ type: 'image', mediaType, data: Buffer.from(bytes).toString('base64') });
      } catch (error) {
        this.env.logger.warn('attachment could not be read', { path: attachment.path, error: messageOf(error) });
      }
    }
    return images;
  }

  private iso(): string {
    return isoAt(this.env.clock.now());
  }
}

function toDeliveredUpdate(update: BackgroundUpdateRecord): DeliveredUpdate {
  return {
    id: update.id,
    taskId: update.taskId,
    title: update.title,
    status: update.status,
    needsInput: update.needsInput,
    report: update.report,
    ...(update.durationMs !== null ? { durationMs: update.durationMs } : {}),
  };
}

/** Recall query of an update turn: the titles and first report lines it delivers. */
function updateQuery(updates: readonly BackgroundUpdateRecord[]): string {
  return updates.map((update) => `${update.title}: ${update.report.split('\n').find((line) => line.trim()) ?? ''}`).join('\n');
}
