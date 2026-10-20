import type { AnyAgentTool, LettaCodeSession } from '@letta-ai/letta-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { ConversationTask, Modality, TextEffort, TurnMode } from '../chat-types';
import { BRIDGE_TOOL_NAMES } from '../mcp-bridge/tools';
import {
  completeDelivery,
  depthAfter,
  receiveNotifications,
  rollbackDelivery,
  takeHeldUpdates,
  taskStarted,
  taskStopRequested,
  unreadCount,
} from './background/service.ts';
import type { UpdateRecord } from './background/store.ts';
import { beginCallResponse, finishCallResponse } from './calls/state.ts';
import { config } from './config';
import { publish } from './conversations/events.ts';
import { CallStateFilter, decodeUserContent, encodeTurn } from './conversations/messages.ts';
import { projectConversationSummary } from './conversations/projection.ts';
import {
  fallbackTitle,
  generateTitle,
  renameConversationIfUntitled,
} from './conversations/titles.ts';
import { claimAttachmentReferenceToken } from './filesystem/attachment-retention';
import { assistant, getMcpToolNames, letta } from './letta/agent-client.ts';
import { mcpToolsReminder } from './mcp-context';
import { assistantModelSettings } from './letta/model-adapter.ts';
import { executeTurn } from './runtime/executor';
import { createRuntimeRegistry } from './runtime/registry';
import { SerialScheduler } from './runtime/scheduler';
import {
  SessionReader,
  registerToolsInline,
  waitUntilIdle,
  withAbort,
} from './runtime/session-adapter';
import type { TurnOutcome, TurnRequest } from './runtime/types';
import { createTools, toolsFor } from './tools';

export { SessionReader, waitUntilIdle };

export type { TurnOutcome, TurnRequest } from './runtime/types';

/** Letta's native worker tools, by the names the model sees. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const STOP_TOOL = 'TaskStop';
/** Built-in tools: MemFS file edits and git (memory), native workers and their cancellation. */
const BUILTIN_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Task', 'TaskStop'];

const SESSION_IDLE_MS = 15 * 60_000;
const MAX_PENDING_TURNS = 32;

function formatCurrentDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  const offset = part('timeZoneName').replace(/^GMT/, '') || '+00:00';
  return (
    `${part('year')}-${part('month')}-${part('day')}T` +
    `${part('hour')}:${part('minute')}:${part('second')}${offset}[${timeZone}]`
  );
}


/**
 * Owns the live Letta session for one conversation. Every producer — text
 * chat, voice turns, background updates — goes through `run()`, which
 * serializes turns, supplies the turn's interaction mode, picks the model for
 * its modality and fans the streamed output out to subscribers.
 */
class ConversationRuntime {
  private session: Promise<LettaCodeSession> | null = null;
  private readers = new WeakMap<LettaCodeSession, SessionReader>();
  private nativeReader: SessionReader | null = null;
  private model: string | null = null;
  /** The session's client tools, and the modality whose tools are registered with Letta. */
  private tools: AnyAgentTool[] = [];
  private toolsModality: Modality | null = null;
  /** Last MCP inventory shown to this conversation, for incremental reminders. */
  private mcpToolNames: string[] | null = null;
  private titled = true;
  private scheduler = new SerialScheduler();
  /** Stops the turn being run (the user pressed stop). */
  private stopCurrent: AbortController | null = null;
  private pending = 0;
  private maintenance = 0;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private heldClaims: UpdateRecord[] = [];
  lastUsed = Date.now();

  constructor(readonly conversationId: string) {}

  run(request: TurnRequest): Promise<TurnOutcome> {
    return (
      this.tryRun(request) ??
      Promise.resolve({
        success: false,
        text: '',
        error:
          this.closing || this.closed
            ? 'runtime closed'
            : 'conversation busy: pending turn limit reached',
      })
    );
  }

  /** Atomically admit a turn, or return null when closed or at the queue limit. */
  tryRun(request: TurnRequest): Promise<TurnOutcome> | null {
    if (this.closing || this.closed || this.pending >= MAX_PENDING_TURNS) return null;
    this.pending++;
    this.lastUsed = Date.now();
    const turn = this.scheduler.schedule(async () => {
      if (this.closing || this.closed) return { success: false, text: '', error: 'runtime closed' };
      return this.runTurn(request);
    });
    void turn
      .finally(() => {
        this.pending--;
      })
      .catch(() => undefined);
    return turn;
  }

  /** Open the session and select the model and tools ahead of time (called when a call starts). */
  warm(modality: Modality): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(new Error('runtime closed'));
    this.maintenance++;
    const job = this.scheduler.schedule(async () => {
      const session = await this.ensureSession();
      await this.useModel(session, modality);
      await this.useTools(session, modality);
    });
    void job
      .finally(() => {
        this.maintenance--;
      })
      .catch(() => undefined);
    return job;
  }

  /** Ask Letta to reflect on this conversation in the background (memory consolidation). */
  reflect(): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(new Error('runtime closed'));
    this.maintenance++;
    const job = this.scheduler.schedule(async () => {
      const session = await this.ensureSession();
      await this.useModel(session, 'text');
      const { agentId } = await assistant();
      const response = await session.sendCommand(
        {
          type: 'execute_command',
          command_id: 'reflect',
          request_id: randomUUID(),
          runtime: { agent_id: agentId, conversation_id: this.conversationId },
          args: '',
        },
        { responseType: 'execute_command_response', timeoutMs: 60_000 }
      );
      console.info(
        `[assistant] reflection in ${this.conversationId}:`,
        response.output ?? response
      );
    });
    void job
      .finally(() => {
        this.maintenance--;
      })
      .catch(() => undefined);
    return job;
  }

  /** Stop the turn being run, if any. Resolves false when nothing was running. */
  cancel(): boolean {
    if (!this.stopCurrent) {
      if (!this.session || !this.nativeReader?.nativeTurnActive) return false;
      void this.session.then((session) => session.abort()).catch(() => undefined);
      return true;
    }
    this.stopCurrent.abort();
    return true;
  }

  get isBusy(): boolean {
    return this.pending > 0 || this.maintenance > 0 || this.stopCurrent !== null || this.nativeReader?.nativeTurnActive === true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Controls run outside the turn queue, so a stuck turn cannot block Stop. */
  async taskControl(taskId?: string): Promise<ConversationTask[] | { killed: boolean }> {
    const session = await this.ensureSession();
    const { agentId } = await assistant();
    const response = await session.sendCommand(
      {
        type: 'execute_command',
        command_id: taskId ? 'assistant_task_stop' : 'assistant_tasks',
        request_id: randomUUID(),
        runtime: { agent_id: agentId, conversation_id: this.conversationId },
        ...(taskId ? { args: taskId } : {}),
      },
      { responseType: 'execute_command_response', timeoutMs: 20_000 }
    );
    if (response.success !== true || typeof response.output !== 'string')
      throw new Error(
        typeof response.error === 'string'
          ? response.error
          : 'Task controls are unavailable. Update the Letta service to enable them.'
      );
    const result: unknown = JSON.parse(response.output);
    if (taskId) {
      if (
        !result ||
        typeof result !== 'object' ||
        !('killed' in result) ||
        typeof result.killed !== 'boolean'
      )
        throw new Error('Invalid task cancellation response');
      return result as { killed: boolean };
    }
    if (
      !Array.isArray(result) ||
      !result.every(
        (task) =>
          task &&
          typeof task.id === 'string' &&
          typeof task.title === 'string' &&
          ['running', 'completed', 'failed', 'cancelled'].includes(task.status)
      )
    )
      throw new Error('Invalid task inventory');
    return result as ConversationTask[];
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.cancel();
    this.closePromise = this.scheduler.idle().then(async () => {
      const opening = this.session;
      this.session = null;
      if (opening) {
        try {
          await (await opening).close();
        } catch {
          /* opening failure already cleaned up */
        }
      }
      this.closed = true;
    });
    return this.closePromise;
  }

  private async runTurn(request: TurnRequest): Promise<TurnOutcome> {
    const stop = new AbortController();
    const turnId = randomUUID();
    this.stopCurrent = stop;
    try {
      const signal = request.signal ? AbortSignal.any([request.signal, stop.signal]) : stop.signal;
      return await this.runTurnWith(request, signal, turnId);
    } catch (cause) {
      const error =
        stop.signal.aborted || request.signal?.aborted
          ? 'aborted'
          : cause instanceof Error
            ? cause.message
            : String(cause);
      publish(this.conversationId, { type: 'turn_end', turnId, success: false, error });
      void this.close();
      return { success: false, text: '', error };
    } finally {
      await this.finishHeldClaims(false);
      if (this.stopCurrent === stop) this.stopCurrent = null;
    }
  }

  private async runTurnWith(
    request: TurnRequest,
    signal: AbortSignal,
    turnId: string
  ): Promise<TurnOutcome> {
    if (signal.aborted) return { success: false, text: '', error: 'aborted' };
    const started = performance.now();
    let firstTokenAt: number | null = null;
    const isUpdate = request.kind === 'update';
    const voice = request.modality === 'voice';
    const mode: TurnMode = voice
      ? `voice-${beginCallResponse(this.conversationId) ?? 'short'}`
      : 'text';
    // Work started while answering an update is one step further from the user.
    const depth = isUpdate ? depthAfter(request.updates ?? []) : 0;
    // Voice responses end with their call state marker, which is never spoken or shown.
    const markers = voice ? new CallStateFilter() : null;
    const finishCall = (success: boolean) => {
      if (!voice) return;
      const state = markers?.state ?? null;
      finishCallResponse(this.conversationId, { reply: !isUpdate, success, state });
    };

    let session: LettaCodeSession;
    let readyAt = started;
    try {
      session = await withAbort(this.ensureSession(), signal);
      await waitUntilIdle(session, 15_000, signal);
      await withAbort(this.useModel(session, request.modality, request.effort), signal);
      await withAbort(this.useTools(session, request.modality), signal);
      readyAt = performance.now();
    } catch (error) {
      this.close();
      finishCall(false);
      const message = signal.aborted
        ? 'aborted'
        : error instanceof Error
          ? error.message
          : String(error);
      publish(this.conversationId, { type: 'turn_end', turnId, success: false, error: message });
      return { success: false, text: '', error: message };
    }
    // Stopped while getting ready: the message is never sent.
    if (signal.aborted) {
      finishCall(false);
      publish(this.conversationId, { type: 'turn_end', turnId, success: false, error: 'aborted' });
      return { success: false, text: '', error: 'aborted' };
    }

    const held = await takeHeldUpdates(this.conversationId);
    this.heldClaims = held;
    const updates = [...(request.updates ?? []), ...held];
    const currentMcpToolNames = await getMcpToolNames();
    const toolReminder = mcpToolsReminder(currentMcpToolNames, this.mcpToolNames);
    this.mcpToolNames = [...new Set(currentMcpToolNames)];
    const encoded = encodeTurn(
      mode,
      request.text,
      updates,
      request.attachments,
      formatCurrentDateTime(new Date(), config.assistant.timezone),
      request.clientMessageId,
      toolReminder
    );
    const otid = randomUUID();
    publish(this.conversationId, { type: 'turn_start', turnId, modality: request.modality });
    decodeUserContent(encoded).forEach((part, index) => {
      if (part.kind === 'user') {
        publish(this.conversationId, {
          type: 'message',
          turnId,
          message: {
            id: otid,
            role: 'user',
            text: part.text,
            modality: part.modality,
            ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
            ...(part.attachments ? { attachments: part.attachments } : {}),
          },
        });
        const titleText = part.text || part.attachments?.map((a) => a.name).join(', ');
        if (!this.titled && titleText) this.autoTitle(titleText);
      } else {
        const { kind, ...rest } = part;
        publish(this.conversationId, {
          type: 'message',
          turnId,
          message: { id: `${otid}:${index}`, role: 'event', kind, ...rest, unread: true },
        });
      }
    });

    const execution = await executeTurn({
      conversationId: this.conversationId,
      session,
      reader: this.readers.get(session)!,
      request,
      signal,
      encoded,
      otid,
      turnId,
      mode,
      depth,
      markers,
      onNativeTool: (call, result, turnMode, turnDepth) =>
        this.observeNativeTool(call, result, turnMode, turnDepth),
      onSessionFailure: () => this.close(),
    });
    this.lastUsed = Date.now();
    const { text } = execution;
    let { error, success } = execution;
    firstTokenAt = execution.firstTokenAt;
    if (signal.aborted) {
      success = false;
      error = 'aborted';
    }
    finishCall(success);
    const ms = (t: number | null) => (t === null ? '-' : `${Math.round(t - started)}ms`);
    console.info(
      `[assistant] ${mode}${isUpdate ? ' update' : ''} turn ${success ? 'ok' : 'failed'} in ${this.conversationId}: ` +
        `ready ${ms(readyAt)}, first token ${ms(firstTokenAt)}, total ${ms(performance.now())}`
    );
    if (!success && error !== 'aborted') {
      console.error(`[assistant] ${mode} turn failed in ${this.conversationId}:`, error);
    }
    publish(this.conversationId, { type: 'turn_end', turnId, success, error });
    await this.finishHeldClaims(success);
    return { success, text, error };
  }

  private async finishHeldClaims(success: boolean): Promise<void> {
    const claims = this.heldClaims.splice(0);
    for (const update of claims) {
      if (!update.deliveryToken) continue;
      try {
        if (success) await completeDelivery(this.conversationId, update.id, update.deliveryToken);
        else await rollbackDelivery(this.conversationId, update.id, update.deliveryToken);
      } catch (error) {
        console.warn(`[assistant] could not settle update ${update.id}:`, error);
      }
    }
  }

  /**
   * Capture the origin of background work started in this turn (workers, and
   * commands Letta moved to the background), and deliberate stops.
   */
  private async observeNativeTool(
    call: { name: string; args: string } | undefined,
    result: { content: unknown; isError?: boolean },
    mode: TurnMode,
    depth: number
  ): Promise<void> {
    if (!call) return;
    if (call.name === 'mcp_call' || call.name === 'mcp_call_write') {
      const text = stringify(result.content);
      const token = text.match(/\[\[mcp-managed-artifacts:v1:([0-9a-f-]{36})\]\]/i)?.[1];
      if (token) {
        await claimAttachmentReferenceToken(this.conversationId, token).catch((error) => {
          console.warn(
            `[assistant] could not retain MCP artifacts in ${this.conversationId}:`,
            error
          );
        });
      }
    }
    if (result.isError) return;
    const args = parseJson(call.args);
    if (call.name === STOP_TOOL) {
      if (typeof args.task_id === 'string')
        await taskStopRequested(this.conversationId, args.task_id);
      return;
    }
    // File reads, searches and other tools can quote task receipts in their
    // output. They cannot launch a native worker or background shell command.
    if (!AGENT_TOOLS.has(call.name) && !['Bash', 'exec_command'].includes(call.name)) return;
    const title = [args.description, args.command].find((v) => typeof v === 'string');
    await taskStarted({
      conversationId: this.conversationId,
      mode,
      depth,
      title: (title as string | undefined) ?? 'Background task',
      prompt: typeof args.prompt === 'string' ? args.prompt : typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : undefined,
      toolResult: stringify(result.content),
      worker: AGENT_TOOLS.has(call.name),
    });
  }

  private ensureSession(): Promise<LettaCodeSession> {
    this.session ??= this.openSession().catch((error) => {
      this.session = null;
      throw error;
    });
    return this.session;
  }

  private async openSession(): Promise<LettaCodeSession> {
    const tools = toolsFor(createTools(this.conversationId));
    const session = letta().resumeSession(this.conversationId, {
      tools,
      toolset: { base: 'none', include: BUILTIN_TOOLS },
      // The allowlist also filters mod tools: the MCP bridge's (registered only
      // while some MCP server lists tools, see mcp/native-tools.ts).
      allowedTools: [...BUILTIN_TOOLS, ...BRIDGE_TOOL_NAMES, ...tools.map((tool) => tool.name)],
      skillSources: [],
      permissionMode: 'unrestricted',
      dreaming: { trigger: 'step-count', stepCount: config.memory.reflectionStepCount },
    });
    try {
      await withAbort(session.ready(), AbortSignal.timeout(30_000));
      await this.reconcileMcpArtifactReferences().catch((error) => {
        console.warn(
          `[assistant] could not reconcile MCP artifact references in ${this.conversationId}:`,
          error
        );
      });
      await registerToolsInline(session, tools, this.conversationId);
      const conversation = await letta().conversations.retrieve(this.conversationId);
      this.nativeReader = new SessionReader(session, this.conversationId, {
          receiveNotifications,
          onNativeTool: (call, result) => this.observeNativeTool(call, result, 'text', 1),
      });
      this.readers.set(session, this.nativeReader);
      this.tools = tools;
      this.toolsModality = 'text';
      this.model = null; // unknown reasoning tier: select explicitly on the first turn
      this.titled = Boolean(conversation.summary?.trim());
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  /** Apply effort and thinking separately while keeping one assistant model. */
  private async useModel(
    session: LettaCodeSession,
    modality: Modality,
    effort: TextEffort = 'medium'
  ): Promise<void> {
    const settings = assistantModelSettings(modality, effort);
    const selection = JSON.stringify([config.model.handle, settings]);
    if (this.model === selection) return;
    await session.updateModel({ modelHandle: config.model.handle, reasoningEffort: settings.effort });
    await letta().conversations.update(this.conversationId, { modelSettings: settings });
    this.model = selection;
  }

  /** The client tools follow the modality of the turn being run (see `toolsFor`). */
  private async useTools(session: LettaCodeSession, modality: Modality): Promise<void> {
    if (this.toolsModality === modality) return;
    await registerToolsInline(session, this.tools, this.conversationId);
    this.toolsModality = modality;
  }

  /**
   * Name the conversation from its first message, in the background: Claude
   * writes a short title while the turn itself runs. Falls back to the
   * message text when the model fails.
   */
  private autoTitle(firstUserText: string): void {
    this.titled = true;
    void generateTitle(firstUserText)
      .catch((error: unknown) => {
        console.warn(`[assistant] title generation failed in ${this.conversationId}:`, error);
        return fallbackTitle(firstUserText);
      })
      .then((title) => renameConversationIfUntitled(this.conversationId, title))
      .then(
        (updated) =>
          updated &&
          publish(this.conversationId, {
            type: 'conversation_updated',
            conversation: projectConversationSummary(updated, unreadCount(updated.id)),
          })
      )
      .catch(() => {
        this.titled = false;
      });
  }

  /** Recover the small save/claim gap if the process stopped after Letta stored a tool result. */
  private async reconcileMcpArtifactReferences(): Promise<void> {
    let before: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page += 1) {
      const result = await letta().conversations.listMessages(this.conversationId, {
        order: 'desc',
        limit: 100,
        ...(before ? { before } : {}),
      });
      for (const message of result.messages) {
        const tokens = JSON.stringify(message).matchAll(
          /\[\[mcp-managed-artifacts:v1:([0-9a-f-]{36})\]\]/gi
        );
        for (const match of tokens)
          await claimAttachmentReferenceToken(this.conversationId, match[1]!);
      }
      if (result.messages.length < 100) return;
      const next = String(result.messages.at(-1)?.id ?? '');
      if (!next || seen.has(next)) return;
      seen.add(next);
      before = next;
    }
  }
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .join('');
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = createRuntimeRegistry((id) => new ConversationRuntime(id));

/** Start the session idle reaper as part of application startup. */
export function startRuntimeMaintenance(): void {
  registry.startIdleCleanup(SESSION_IDLE_MS, 60_000);
}

/** Stop the reaper and drain every conversation session during shutdown. */
export function closeAllConversationRuntimes(): Promise<void> {
  return registry.closeAll();
}

export function conversationRuntime(conversationId: string): ConversationRuntime {
  return registry.get(conversationId);
}

/** Drop a conversation's live session (e.g. after its history moved to a fork). */
export async function closeConversationRuntime(conversationId: string): Promise<void> {
  return registry.close(conversationId);
}

/** Drain turns and hold a registry tombstone until a fork/archive mutation ends. */
export async function withConversationMutation<T>(
  conversationId: string,
  operation: () => Promise<T>
): Promise<T> {
  return registry.withMutation(conversationId, operation);
}
