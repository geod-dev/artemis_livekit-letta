import type {
  AnyAgentTool,
  ImageContent,
  LettaCodeSession,
  SDKMessage,
  SDKQueueItem,
} from '@letta-ai/letta-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { ChatAttachment, Modality, TextEffort, TurnMode } from '../chat-types';
import { BRIDGE_TOOL_NAMES } from '../mcp-bridge/tools';
import { mcpCatalog } from '../mcp/native-tools';
import {
  depthAfter,
  receiveNotifications,
  takeHeldUpdates,
  taskStarted,
  taskStopRequested,
} from './background';
import type { UpdateRecord } from './background-store';
import { beginCallResponse, finishCallResponse } from './calls';
import { config } from './config';
import { toSummary } from './conversations';
import { publish } from './events';
import { assistant, letta } from './letta';
import { mcpContextReminder } from './mcp-context';
import { CallStateFilter, decodeUserContent, encodeTurn } from './messages';
import { modelEffort } from './model-effort';
import { fallbackTitle, generateTitle } from './titles';
import { createTools, toolsFor } from './tools';

export interface TurnRequest {
  /** The user's words; empty for a turn that only delivers background updates. */
  text: string;
  modality: Modality;
  /** Text-only user preference; voice keeps using the fast model. */
  effort?: TextEffort;
  /** `update` turns deliver finished background work into the conversation. */
  kind?: 'user' | 'update';
  /** Background updates this turn delivers. Held updates are added to any turn. */
  updates?: UpdateRecord[];
  /** Files the user attached (in the workspace), and the images among them. */
  attachments?: ChatAttachment[];
  images?: ImageContent[];
  /** Abort the turn (e.g. the voice user interrupted). */
  signal?: AbortSignal;
  /** Receives assistant text as it streams (used by the voice endpoints). */
  onText?: (delta: string) => void;
}

/** Letta's native worker tools, by the names the model sees. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const STOP_TOOL = 'TaskStop';
/** Built-in tools: MemFS file edits and git (memory), native workers and their cancellation. */
const BUILTIN_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Task', 'TaskStop'];

export interface TurnOutcome {
  success: boolean;
  text: string;
  error?: string;
}

const SESSION_IDLE_MS = 15 * 60_000;
const BROKEN_SESSION_CODES = new Set(['stream_closed', 'protocol_error']);

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

type ModelTier = keyof Pick<typeof config.models, 'smart' | 'fast'>;

/** Text chat gets the smart model; voice needs the fast one. */
const TIER_FOR: Record<Modality, ModelTier> = { text: 'smart', voice: 'fast' };

/**
 * Owns the live Letta session for one conversation. Every producer — text
 * chat, voice turns, background updates — goes through `run()`, which
 * serializes turns, supplies the turn's interaction mode, picks the model for
 * its modality and fans the streamed output out to subscribers.
 */
class ConversationRuntime {
  private session: Promise<LettaCodeSession> | null = null;
  private readers = new WeakMap<LettaCodeSession, SessionReader>();
  private model: string | null = null;
  /** The session's client tools, and the modality whose tools are registered with Letta. */
  private tools: AnyAgentTool[] = [];
  private toolsModality: Modality | null = null;
  private titled = true;
  private chain: Promise<unknown> = Promise.resolve();
  /** Stops the turn being run (the user pressed stop). */
  private stopCurrent: AbortController | null = null;
  lastUsed = Date.now();

  constructor(readonly conversationId: string) {}

  run(request: TurnRequest): Promise<TurnOutcome> {
    this.lastUsed = Date.now();
    const turn = this.chain.then(() => this.runTurn(request));
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  /** Open the session and select the model and tools ahead of time (called when a call starts). */
  warm(modality: Modality): Promise<void> {
    const job = this.chain.then(async () => {
      const session = await this.ensureSession();
      await this.useModel(session, TIER_FOR[modality]);
      await this.useTools(session, modality);
    });
    this.chain = job.catch(() => undefined);
    return job;
  }

  /** Ask Letta to reflect on this conversation in the background (memory consolidation). */
  reflect(): Promise<void> {
    const job = this.chain.then(async () => {
      const session = await this.ensureSession();
      // Reflection runs on the conversation's current model. After a call that is
      // the fast model; consolidate with the smart model instead.
      await this.useModel(session, 'smart');
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
    this.chain = job.catch(() => undefined);
    return job;
  }

  /** Stop the turn being run, if any. Resolves false when nothing was running. */
  cancel(): boolean {
    if (!this.stopCurrent) return false;
    this.stopCurrent.abort();
    return true;
  }

  close(): void {
    const session = this.session;
    this.session = null;
    void session?.then((s) => s.close()).catch(() => undefined);
  }

  private async runTurn(request: TurnRequest): Promise<TurnOutcome> {
    const stop = new AbortController();
    this.stopCurrent = stop;
    try {
      const signal = request.signal ? AbortSignal.any([request.signal, stop.signal]) : stop.signal;
      return await this.runTurnWith(request, signal);
    } finally {
      if (this.stopCurrent === stop) this.stopCurrent = null;
    }
  }

  private async runTurnWith(request: TurnRequest, signal: AbortSignal): Promise<TurnOutcome> {
    if (signal.aborted) return { success: false, text: '', error: 'aborted' };
    const turnId = randomUUID();
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
      session = await this.ensureSession();
      await waitUntilIdle(session);
      const tier = request.modality === 'voice' || request.effort === 'fast' ? 'fast' : 'smart';
      const reasoning = tier === 'smart' && request.effort !== 'fast' ? request.effort : undefined;
      await this.useModel(session, tier, reasoning);
      await this.useTools(session, request.modality);
      readyAt = performance.now();
    } catch (error) {
      this.close();
      finishCall(false);
      const message = error instanceof Error ? error.message : String(error);
      publish(this.conversationId, { type: 'turn_end', turnId, success: false, error: message });
      return { success: false, text: '', error: message };
    }
    // Stopped while getting ready: the message is never sent.
    if (signal.aborted) {
      finishCall(false);
      publish(this.conversationId, { type: 'turn_end', turnId, success: false, error: 'aborted' });
      return { success: false, text: '', error: 'aborted' };
    }

    const updates = [...(request.updates ?? []), ...takeHeldUpdates(this.conversationId)];
    const encoded =
      mcpContextReminder(mcpCatalog.snapshot().tools) +
      encodeTurn(
        mode,
        request.text,
        updates,
        request.attachments,
        formatCurrentDateTime(new Date(), config.assistant.timezone)
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

    const onAbort = () => void session.abort().catch(() => undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    let text = '';
    let error: string | undefined;
    let success = false;
    const announcedTools = new Set<string>();
    const toolCalls = new Map<string, { name: string; args: string }>();
    let lastMessageId: string = otid;
    const emitText = (delta: string) => {
      if (!delta) return;
      text += delta;
      request.onText?.(delta);
      publish(this.conversationId, {
        type: 'assistant_delta',
        turnId,
        messageId: lastMessageId,
        text: delta,
      });
    };
    try {
      const messages = this.readers.get(session)!.nextTurn();
      const images = request.images ?? [];
      await session.send(images.length ? [{ type: 'text', text: encoded }, ...images] : encoded, {
        otid,
      });
      for await (const message of messages) {
        switch (message.type) {
          case 'reasoning': {
            if (!message.content) break;
            publish(this.conversationId, {
              type: 'reasoning_delta',
              turnId,
              messageId: message.otid ?? message.uuid,
              text: message.content,
            });
            break;
          }
          case 'assistant': {
            if (!message.content) break;
            firstTokenAt ??= performance.now();
            lastMessageId = message.otid ?? message.uuid;
            emitText(markers ? markers.push(message.content) : message.content);
            break;
          }
          case 'tool_call': {
            const call = toolCalls.get(message.toolCallId) ?? { name: message.toolName, args: '' };
            call.args = mergeToolArguments(call.args, message);
            toolCalls.set(message.toolCallId, call);
            if (announcedTools.has(message.toolCallId)) break;
            announcedTools.add(message.toolCallId);
            publish(this.conversationId, {
              type: 'tool_call',
              turnId,
              toolCallId: message.toolCallId,
              name: message.toolName,
            });
            break;
          }
          case 'tool_result':
            this.observeNativeTool(toolCalls.get(message.toolCallId), message, mode, depth);
            publish(this.conversationId, {
              type: 'tool_result',
              turnId,
              toolCallId: message.toolCallId,
              args: toolCalls.get(message.toolCallId)?.args || undefined,
              result: stringify(message.content),
              isError: Boolean(message.isError),
            });
            break;
          case 'error':
            error = message.message;
            break;
          case 'result':
            success = message.success;
            if (!message.success) {
              error ??= message.errorCode ?? message.error ?? 'turn failed';
              if (message.errorCode && BROKEN_SESSION_CODES.has(message.errorCode)) this.close();
            }
            break;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      this.close();
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.lastUsed = Date.now();
    }
    if (markers) emitText(markers.flush());

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
    return { success, text, error };
  }

  /**
   * Capture the origin of background work started in this turn (workers, and
   * commands Letta moved to the background), and deliberate stops.
   */
  private observeNativeTool(
    call: { name: string; args: string } | undefined,
    result: { content: unknown; isError?: boolean },
    mode: TurnMode,
    depth: number
  ): void {
    if (!call || result.isError) return;
    const args = parseJson(call.args);
    if (call.name === STOP_TOOL) {
      if (typeof args.task_id === 'string') taskStopRequested(this.conversationId, args.task_id);
      return;
    }
    const title = [args.description, args.command].find((v) => typeof v === 'string');
    taskStarted({
      conversationId: this.conversationId,
      mode,
      depth,
      title: (title as string | undefined) ?? 'Background task',
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
    const tools = createTools(this.conversationId);
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
    await session.ready();
    this.readers.set(session, new SessionReader(session, this.conversationId));
    await registerToolsInline(session, toolsFor(tools, 'text'), this.conversationId);
    this.tools = tools;
    this.toolsModality = 'text';
    const conversation = await letta().conversations.retrieve(this.conversationId);
    this.model = null; // unknown reasoning tier: select explicitly on the first turn
    this.titled = Boolean(conversation.summary?.trim());
    return session;
  }

  /** The conversation's model follows the modality of the turn being run. */
  private async useModel(
    session: LettaCodeSession,
    tier: ModelTier,
    effort?: Exclude<TextEffort, 'fast'>
  ): Promise<void> {
    const { handle } = config.models[tier];
    const reasoning = modelEffort(handle, effort ?? config.models[tier].reasoning);
    // Compare handle *and* reasoning tier: both tiers may share one model.
    const selection = `${handle}|${reasoning}`;
    if (this.model === selection) return;
    try {
      await session.updateModel(
        reasoning
          ? { modelHandle: handle, reasoningEffort: reasoning as never }
          : { modelHandle: handle }
      );
    } catch (error) {
      // Explicit slider choices must never silently run at the default effort.
      if (effort) throw error;
      // Non-user selections can use the default for models without tiers.
      if (!reasoning || !/reasoning/i.test(String(error))) throw error;
      await session.updateModel({ modelHandle: handle });
    }
    this.model = selection;
  }

  /** The client tools follow the modality of the turn being run (see `toolsFor`). */
  private async useTools(session: LettaCodeSession, modality: Modality): Promise<void> {
    if (this.toolsModality === modality) return;
    await registerToolsInline(session, toolsFor(this.tools, modality), this.conversationId);
    this.toolsModality = modality;
  }

  /**
   * Name the conversation from its first message, in the background: the fast
   * model writes a short title while the turn itself runs. Falls back to the
   * message text when the model fails.
   */
  private autoTitle(firstUserText: string): void {
    this.titled = true;
    void generateTitle(firstUserText)
      .catch((error: unknown) => {
        console.warn(`[assistant] title generation failed in ${this.conversationId}:`, error);
        return fallbackTitle(firstUserText);
      })
      .then((title) => letta().conversations.update(this.conversationId, { summary: title }))
      .then((updated) =>
        publish(this.conversationId, {
          type: 'conversation_updated',
          conversation: toSummary(updated),
        })
      )
      .catch(() => {
        this.titled = false;
      });
  }
}

/**
 * Reads a session's stream continuously and hands messages to the turn being
 * run. Letta also emits messages outside the gateway's turns (queue updates,
 * turns it starts or cancels on its own, e.g. a notification turn handed to
 * the gateway); left in the SDK's queue, they would open the next turn's
 * stream. Without a running turn they are dropped.
 */
class SessionReader {
  private sink: ((message: SDKMessage | null) => void) | null = null;
  private claimed = new Set<string>();

  constructor(
    private readonly session: LettaCodeSession,
    private readonly conversationId: string
  ) {
    void this.pump();
  }

  /** The messages of the next turn, up to its result. Call before sending the turn. */
  nextTurn(): AsyncIterable<SDKMessage> {
    const queue: (SDKMessage | null)[] = [];
    let wake: (() => void) | null = null;
    this.sink = (message) => {
      queue.push(message);
      wake?.();
    };
    const release = () => (this.sink = null);
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
            wake = null;
            const message = queue.shift();
            if (message === undefined) continue;
            if (message === null) {
              yield { type: 'result', success: false, errorCode: 'stream_closed' } as SDKMessage;
              return;
            }
            yield message;
            if (message.type === 'result') return;
          }
        } finally {
          release();
        }
      },
    };
  }

  private async pump(): Promise<void> {
    for (;;) {
      let received = 0;
      for await (const message of this.session.stream()) {
        received++;
        if (message.type === 'queue_update') this.claimNotifications(message.queue);
        if (this.sink) this.sink(message);
        else if (message.type === 'result' || message.type === 'error') {
          console.info(
            `[assistant] ignored ${message.type} outside a turn in ${this.conversationId}`
          );
        }
      }
      if (received === 0) break; // the session closed
    }
    this.sink?.(null);
  }

  /**
   * Letta merges notifications queued during a turn into that turn's next tool
   * continuation, which mod `turn_start` handlers never see. Take them out of
   * Letta's queue as soon as they are queued and hand them to the gateway. One
   * Letta has already consumed stays with Letta (no duplicate delivery).
   */
  private claimNotifications(queue: readonly SDKQueueItem[]): void {
    for (const item of queue) {
      if (item.kind !== 'task_notification' || this.claimed.has(item.id)) continue;
      const text = typeof item.content === 'string' ? item.content : contentText(item.content);
      if (!text.includes('<task-notification>')) continue;
      this.claimed.add(item.id);
      void this.session
        .removeQueuedMessage(item.id)
        .then(({ removed }) => {
          if (removed) receiveNotifications(this.conversationId, [text]);
        })
        .catch((error: unknown) =>
          console.warn(`[assistant] could not claim queued notification ${item.id}:`, error)
        );
    }
  }
}

function contentText(content: unknown): string {
  return Array.isArray(content)
    ? content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
    : '';
}

/** Let a turn Letta is running on its own settle before sending one (bounded wait). */
async function waitUntilIdle(session: LettaCodeSession, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await session.getDeviceStatus({ timeoutMs: 5_000 }).catch(() => null);
    if (!status?.isProcessing) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * The SDK registers client tools with Letta's default `auto_background`, which
 * hands any call that runs >10s to a later task notification. Client tools are
 * quick actions whose outcome belongs in the current response, so re-publish
 * the same definitions (same connection, same handlers) with inline waiting.
 * Longer work goes to Letta's native background workers instead.
 */
async function registerToolsInline(
  session: LettaCodeSession,
  tools: AnyAgentTool[],
  conversationId: string
): Promise<void> {
  const { agentId } = await assistant();
  await session.sendCommand(
    {
      type: 'runtime_external_tools_update',
      request_id: randomUUID(),
      updates: [
        {
          runtimes: [{ agent_id: agentId, conversation_id: conversationId }],
          external_tools: [
            {
              tools: tools.map((tool) => ({
                name: tool.name,
                label: tool.label,
                description: tool.description,
                parameters: tool.parameters,
                auto_background: false,
                timeout_ms: 60_000,
              })),
            },
          ],
        },
      ],
    },
    { responseType: 'runtime_external_tools_update_response', timeoutMs: 15_000 }
  );
}

/** Tool arguments stream as fragments (`rawArguments`) or arrive parsed (`toolInput`). */
function mergeToolArguments(
  previous: string,
  message: { toolInput: Record<string, unknown>; rawArguments?: string }
): string {
  if (message.rawArguments !== undefined) return previous + message.rawArguments;
  const input = message.toolInput;
  if (typeof input.raw === 'string') return previous + input.raw;
  return Object.keys(input).length ? JSON.stringify(input) : previous;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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

const runtimes = new Map<string, ConversationRuntime>();
setInterval(() => {
  for (const [id, runtime] of runtimes) {
    if (Date.now() - runtime.lastUsed > SESSION_IDLE_MS) {
      runtime.close();
      runtimes.delete(id);
    }
  }
}, 60_000).unref();

export function conversationRuntime(conversationId: string): ConversationRuntime {
  let runtime = runtimes.get(conversationId);
  if (!runtime) {
    runtime = new ConversationRuntime(conversationId);
    runtimes.set(conversationId, runtime);
  }
  return runtime;
}

/** Drop a conversation's live session (e.g. after its history moved to a fork). */
export function closeConversationRuntime(conversationId: string): void {
  runtimes.get(conversationId)?.close();
  runtimes.delete(conversationId);
}
