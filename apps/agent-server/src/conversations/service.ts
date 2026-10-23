import type { ToolDefinition } from '@artemis/llm';
import {
  type ChatMessage,
  type ConversationContextUsage,
  type ConversationSummary,
  DEFAULT_CONVERSATION_TITLE,
  type TurnMode,
} from '@artemis/contracts/chat-types';
import type { MessageDeleteResponse, TextTurnRequest } from '@artemis/contracts/agent-server';
import { AppError, NotFoundError, uuid } from '@artemis/core';
import type { BackgroundUpdateRecord, ConversationRecord, Storage } from '@artemis/storage';
import type { AgentServerConfig } from '../config.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { ModelRouter } from '../models/routing.ts';
import type { PromptRenderer } from '../prompts/renderer.ts';
import type { WorkerSupervisor } from '../workers/supervisor.ts';
import type { TurnHandle } from '../workers/types.ts';
import { projectHistory } from './history.ts';

export type { TurnHandle, TurnOutcome } from '../workers/types.ts';

/** A spoken turn of a call. `mode` is resolved once the main agent is ready, so a call that fails to start opens no response. */
export interface VoiceTurn {
  text: string;
  clientMessageId?: string;
  mode: () => TurnMode;
  signal: AbortSignal;
  onText: (delta: string) => void;
}

/** A spoken background update, claimed by the caller; `deliveryToken` releases or completes it. */
export interface UpdateTurn {
  update: BackgroundUpdateRecord;
  deliveryToken: string;
  mode: () => TurnMode;
  signal: AbortSignal;
  onText: (delta: string) => void;
}

/**
 * Conversation behaviour: CRUD over storage, the prompt snapshot taken at creation,
 * and the turns submitted to a conversation's main agent. Delete = archive (stop
 * workers, release artifacts). Rewind = soft-delete from a message, in place.
 */
export interface ConversationService {
  list(options: { limit: number; after?: string }): Promise<{ items: ConversationSummary[]; nextCursor: string | null }>;
  create(input: { title?: string }): Promise<ConversationSummary>;
  /** Throws `NotFoundError`. */
  require(id: string): Promise<ConversationSummary>;
  rename(id: string, title: string): Promise<ConversationSummary>;
  archive(id: string): Promise<void>;
  /** Soft-deletes the message and every later one; `attachments` lists the uploads that remain. */
  rewind(id: string, messageId: string): Promise<MessageDeleteResponse>;
  /** UI rows, newest page first (`before` = row cursor), plus the next cursor. */
  messages(id: string, options: { before?: string; limit: number }): Promise<{ rows: ChatMessage[]; nextCursor: string | null }>;
  contextUsage(id: string): Promise<ConversationContextUsage | null>;
  /** Queues a typed turn on the conversation's main agent. */
  submitTurn(id: string, request: TextTurnRequest): Promise<TurnHandle>;
  submitVoiceTurn(id: string, turn: VoiceTurn): Promise<TurnHandle>;
  submitUpdateTurn(id: string, turn: UpdateTurn): Promise<TurnHandle>;
  /** Aborts the running turn; false when no turn runs. */
  cancelTurn(id: string): boolean;
  /** Starts the conversation's main agent ahead of a call. */
  warm(id: string): Promise<void>;
}

interface ConversationServiceDeps {
  storage: Storage;
  prompts: PromptRenderer;
  router: ModelRouter;
  events: ConversationEventHub;
  config: Pick<AgentServerConfig, 'assistant' | 'workspace'>;
  /** Starts, peeks at and submits turns to the main agents of conversations. */
  supervisor: Pick<WorkerSupervisor, 'mainAgent' | 'peekMainAgent'>;
  /** Tool definitions frozen with the system prompt (the order sent to the provider). */
  toolDefinitions: () => ToolDefinition[];
  /** Live rows not yet in storage (held background updates), first page only. */
  pendingRows?: (conversationId: string) => Promise<ChatMessage[]>;
  /** Stops the conversation's workers and releases its resources. */
  onArchived?: (conversationId: string) => Promise<void>;
}

class StorageConversationService implements ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  async list(options: { limit: number; after?: string }) {
    const page = await this.deps.storage.conversations.list(options);
    // Unread background results per row (the list's badge; live changes arrive as `unread` list events).
    const items = await Promise.all(page.items.map((record) => this.withUnread(record)));
    return { items, nextCursor: page.nextCursor };
  }

  async create(input: { title?: string }): Promise<ConversationSummary> {
    const id = uuid();
    const title = input.title?.trim() || null;
    const { config, prompts, storage } = this.deps;
    const prompt = await prompts.system({
      name: config.assistant.name,
      workspace: config.workspace.displayRoot,
      conversationId: id,
      timezone: config.assistant.timezone,
    });
    const record = await storage.conversations.create(
      { id, title, titleSource: title ? 'user' : null },
      {
        systemPrompt: prompt.systemPrompt,
        tools: this.deps.toolDefinitions(),
        templateId: prompt.templateId,
        templateHash: prompt.templateHash,
      }
    );
    return this.withUnread(record);
  }

  async require(id: string): Promise<ConversationSummary> {
    return summarize(await this.record(id));
  }

  async rename(id: string, title: string): Promise<ConversationSummary> {
    const clean = title.trim();
    if (!clean) throw new AppError('invalid_title', 'Title must not be empty', 400);
    const record = await this.deps.storage.conversations.rename(id, clean, 'user');
    if (!record) throw new NotFoundError('Conversation');
    const conversation = await this.withUnread(record);
    this.deps.events.publish(id, { type: 'conversation_updated', conversation });
    return conversation;
  }

  async archive(id: string): Promise<void> {
    const archived = await this.deps.storage.conversations.archive(id);
    if (!archived) throw new NotFoundError('Conversation');
    this.deps.events.clear(id);
    await this.deps.onArchived?.(id);
  }

  async rewind(id: string, messageId: string): Promise<MessageDeleteResponse> {
    await this.require(id);
    const message = await this.deps.storage.messages.get(messageId);
    if (!message || message.conversationId !== id || message.taskId !== null) {
      throw new NotFoundError('Message');
    }
    await this.deps.storage.messages.softDeleteFrom(id, messageId);
    return { attachments: await this.remainingAttachmentPaths(id) };
  }

  async messages(id: string, options: { before?: string; limit: number }) {
    await this.require(id);
    const { storage } = this.deps;
    const page = await storage.messages.page(id, options);
    const messages = [...page.items].reverse();
    const toolCalls = await storage.toolCalls.listForMessages(messages.map((message) => message.id));
    const updates = await storage.updates.listByConversation(id);
    const stored = projectHistory({ messages, toolCalls, updates });
    const pending = options.before || !this.deps.pendingRows ? [] : await this.deps.pendingRows(id);
    return { rows: [...stored, ...pending], nextCursor: page.nextCursor };
  }

  async contextUsage(id: string): Promise<ConversationContextUsage | null> {
    await this.require(id);
    const turn = await this.deps.storage.turns.latestWithUsage(id);
    if (!turn?.usage) return null;
    const route = this.deps.router.route('assistant-text');
    const model = turn.model ?? route.model;
    return {
      usedTokens: turn.usage.lastContextTokens,
      windowTokens: route.provider.modelInfo(model).contextWindow,
      model,
      reportedAt: turn.endedAt ?? turn.startedAt,
    };
  }

  async submitTurn(id: string, request: TextTurnRequest): Promise<TurnHandle> {
    const worker = await this.deps.supervisor.mainAgent(id);
    return worker.submit({
      kind: 'user',
      modality: 'text',
      mode: 'text',
      text: request.text,
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
      ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
    });
  }

  async submitVoiceTurn(id: string, turn: VoiceTurn): Promise<TurnHandle> {
    const worker = await this.deps.supervisor.mainAgent(id);
    return worker.submit({
      kind: 'user',
      modality: 'voice',
      mode: turn.mode(),
      text: turn.text,
      ...(turn.clientMessageId ? { clientMessageId: turn.clientMessageId } : {}),
      signal: turn.signal,
      onText: turn.onText,
    });
  }

  async submitUpdateTurn(id: string, turn: UpdateTurn): Promise<TurnHandle> {
    const worker = await this.deps.supervisor.mainAgent(id);
    return worker.submit({
      kind: 'update',
      modality: 'voice',
      mode: turn.mode(),
      text: '',
      updates: [turn.update],
      deliveryToken: turn.deliveryToken,
      signal: turn.signal,
      onText: turn.onText,
    });
  }

  cancelTurn(id: string): boolean {
    return this.deps.supervisor.peekMainAgent(id)?.cancel() ?? false;
  }

  async warm(id: string): Promise<void> {
    await this.deps.supervisor.mainAgent(id);
  }

  /** Workspace paths of the user-message uploads that the conversation still shows. */
  private async remainingAttachmentPaths(id: string): Promise<string[]> {
    const paths = new Set<string>();
    let before: string | undefined;
    do {
      const page = await this.deps.storage.messages.page(id, { ...(before ? { before } : {}), limit: 200 });
      for (const message of page.items) {
        if (message.role !== 'user') continue;
        for (const attachment of message.envelope?.attachments ?? []) paths.add(attachment.path);
      }
      before = page.nextCursor ?? undefined;
    } while (before);
    return [...paths];
  }

  /** A summary with the list's unread count (unread background results of the conversation). */
  private async withUnread(record: ConversationRecord): Promise<ConversationSummary> {
    return { ...summarize(record), unread: await this.deps.storage.updates.unreadCount(record.id) };
  }

  private async record(id: string): Promise<ConversationRecord> {
    const record = await this.deps.storage.conversations.get(id);
    if (!record) throw new NotFoundError('Conversation');
    return record;
  }
}

function summarize(record: ConversationRecord): ConversationSummary {
  return {
    id: record.id,
    title: record.title?.trim() || DEFAULT_CONVERSATION_TITLE,
    updatedAt: record.lastMessageAt ?? record.updatedAt,
  };
}

export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  return new StorageConversationService(deps);
}
