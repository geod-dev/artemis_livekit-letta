import type { ToolDefinition } from '@artemis/llm';
import type { ChatMessage, ConversationContextUsage, ConversationSummary } from '@artemis/contracts/chat-types';
import { AppError, NotFoundError, uuid } from '@artemis/core';
import type { ConversationRecord, Storage } from '@artemis/storage';
import type { AgentServerConfig } from '../config.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { ModelRouter } from '../models/routing.ts';
import type { PromptRenderer } from '../prompts/renderer.ts';
import { projectHistory } from './history.ts';

/**
 * Conversation CRUD over storage. `create` renders and freezes the system
 * prompt + tool definitions (prompt snapshot). Delete = archive (stop workers,
 * release artifacts). Rewind = soft-delete from a message, in place.
 */
export abstract class ConversationService {
  abstract list(options: { limit: number; after?: string }): Promise<{ items: ConversationSummary[]; nextCursor: string | null }>;
  abstract create(input: { title?: string }): Promise<ConversationSummary>;
  /** Throws `NotFoundError`. */
  abstract require(id: string): Promise<ConversationSummary>;
  abstract rename(id: string, title: string): Promise<ConversationSummary>;
  abstract archive(id: string): Promise<void>;
  abstract rewind(id: string, messageId: string): Promise<ConversationSummary | null>;
  /** UI rows, newest page first (`before` = row cursor), plus `X-Next-Cursor`. */
  abstract messages(id: string, options: { before?: string; limit: number }): Promise<{ rows: ChatMessage[]; nextCursor: string | null }>;
  abstract contextUsage(id: string): Promise<ConversationContextUsage | null>;
}

export const DEFAULT_TITLE = 'New chat';

interface ConversationServiceDeps {
  storage: Storage;
  prompts: PromptRenderer;
  router: ModelRouter;
  events: ConversationEventHub;
  config: Pick<AgentServerConfig, 'assistant' | 'workspace'>;
  /** Tool definitions frozen with the system prompt (the order sent to the provider). */
  toolDefinitions: () => ToolDefinition[];
  /** Live rows not yet in storage (held background updates), first page only. */
  pendingRows?: (conversationId: string) => Promise<ChatMessage[]>;
  /** Stops the conversation's workers and releases its resources. */
  onArchived?: (conversationId: string) => Promise<void>;
}

class StorageConversationService extends ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {
    super();
  }

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

  async rewind(id: string, messageId: string): Promise<ConversationSummary | null> {
    await this.require(id);
    const message = await this.deps.storage.messages.get(messageId);
    if (!message || message.conversationId !== id || message.taskId !== null) {
      throw new NotFoundError('Message');
    }
    await this.deps.storage.messages.softDeleteFrom(id, messageId);
    return this.require(id);
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
    title: record.title?.trim() || DEFAULT_TITLE,
    updatedAt: record.lastMessageAt ?? record.updatedAt,
  };
}

export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  return new StorageConversationService(deps);
}
