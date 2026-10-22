/**
 * Repository interfaces. Business logic depends only on these; the Postgres
 * implementation lives in `@artemis/storage/postgres`. An in-memory
 * implementation for tests may be added under `src/memory/` (WP-03).
 */
import type {
  AppStateKey,
  BackgroundUpdateRecord,
  ConversationRecord,
  DeliveryState,
  McpSettingsRecord,
  MemoryRetentionRecord,
  MessageRecord,
  PromptSnapshotRecord,
  TaskRecord,
  ToolCallRecord,
  TurnRecord,
} from './domain.ts';

export interface Page<T> {
  items: T[];
  /** Pass back as `before`/`after` for the next page; null at the end. */
  nextCursor: string | null;
}

export abstract class ConversationRepository {
  /** Creates the conversation and its frozen prompt snapshot atomically. */
  abstract create(
    conversation: Pick<ConversationRecord, 'id' | 'title' | 'titleSource'>,
    snapshot: Omit<PromptSnapshotRecord, 'id' | 'ownerKind' | 'ownerId' | 'createdAt'>
  ): Promise<ConversationRecord>;
  abstract get(id: string, options?: { includeArchived?: boolean }): Promise<ConversationRecord | null>;
  /** Not archived, ordered by `coalesce(last_message_at, created_at) desc`. */
  abstract list(options: { limit: number; after?: string }): Promise<Page<ConversationRecord>>;
  abstract rename(id: string, title: string, source: 'auto' | 'user'): Promise<ConversationRecord | null>;
  /** Sets an `auto` title only while `title_source` is null; returns false if a title already exists. */
  abstract setTitleIfUntitled(id: string, title: string): Promise<boolean>;
  abstract archive(id: string): Promise<boolean>;
  abstract touch(id: string, at: string): Promise<void>;
  abstract setMcpToolNamesShown(id: string, names: string[]): Promise<void>;
}

export abstract class PromptSnapshotRepository {
  abstract create(snapshot: Omit<PromptSnapshotRecord, 'id' | 'createdAt'>): Promise<PromptSnapshotRecord>;
  abstract getForOwner(ownerKind: PromptSnapshotRecord['ownerKind'], ownerId: string): Promise<PromptSnapshotRecord | null>;
}

export abstract class TurnRepository {
  /** Allocates `seq`. */
  abstract create(turn: Omit<TurnRecord, 'seq' | 'endedAt' | 'memoryRetentionId' | 'usage' | 'recall' | 'error'>): Promise<TurnRecord>;
  abstract get(id: string): Promise<TurnRecord | null>;
  abstract finish(
    id: string,
    patch: Pick<TurnRecord, 'status' | 'error' | 'usage' | 'model'> & { endedAt: string }
  ): Promise<void>;
  abstract setRecall(id: string, recall: NonNullable<TurnRecord['recall']>): Promise<void>;
  /** Completed turns without `memoryRetentionId`, in `seq` order. */
  abstract listUnanalyzed(conversationId: string): Promise<TurnRecord[]>;
  abstract markAnalyzed(turnIds: string[], retentionId: string): Promise<void>;
  /** Boot recovery: every `running` turn becomes `failed` with `reason`. Returns their ids. */
  abstract failRunning(reason: string): Promise<string[]>;
  /** Latest completed turn with usage, for `GET .../context-usage`. */
  abstract latestWithUsage(conversationId: string): Promise<TurnRecord | null>;
}

export abstract class MessageRepository {
  /** Allocates `seq` within (conversationId, taskId). */
  abstract append(message: Omit<MessageRecord, 'seq' | 'createdAt' | 'deletedAt'>): Promise<MessageRecord>;
  /** Full non-deleted transcript in `seq` order: the LLM context of a conversation (taskId null) or task. */
  abstract transcript(conversationId: string, taskId: string | null): Promise<MessageRecord[]>;
  /** Conversation transcript page, newest first; `before` is a message id. */
  abstract page(conversationId: string, options: { before?: string; limit: number }): Promise<Page<MessageRecord>>;
  abstract get(id: string): Promise<MessageRecord | null>;
  /** Soft-deletes `messageId` and every later message (and their turns' tool calls) of the conversation. */
  abstract softDeleteFrom(conversationId: string, messageId: string): Promise<number>;
}

export abstract class ToolCallRepository {
  abstract start(call: Omit<ToolCallRecord, 'status' | 'resultText' | 'isError' | 'display' | 'taskRef' | 'endedAt'>): Promise<void>;
  abstract finish(
    id: string,
    patch: Pick<ToolCallRecord, 'status' | 'resultText' | 'isError' | 'display' | 'taskRef'> & { endedAt: string | null }
  ): Promise<void>;
  abstract listForMessages(messageIds: string[]): Promise<ToolCallRecord[]>;
  /** Boot recovery: `running` calls become `cancelled`. */
  abstract cancelRunning(reason: string): Promise<number>;
}

export abstract class TaskRepository {
  abstract create(task: Omit<TaskRecord, 'endedAt' | 'stopRequestedAt' | 'exitCode' | 'stdoutTail' | 'stderrTail' | 'report' | 'usage'>): Promise<TaskRecord>;
  abstract get(id: string): Promise<TaskRecord | null>;
  abstract listByConversation(conversationId: string, options?: { limit?: number }): Promise<TaskRecord[]>;
  abstract listRunning(conversationId?: string): Promise<TaskRecord[]>;
  /** Periodic output/progress persistence of a running task. */
  abstract updateProgress(id: string, patch: Partial<Pick<TaskRecord, 'stdoutTail' | 'stderrTail' | 'usage' | 'outputPath'>>): Promise<void>;
  abstract requestStop(id: string, at: string): Promise<void>;
  /** Terminal transition; no-op (returns null) if the task already finished. */
  abstract finish(
    id: string,
    patch: Pick<TaskRecord, 'status' | 'report' | 'needsInput' | 'exitCode' | 'stdoutTail' | 'stderrTail' | 'usage'> & { endedAt: string }
  ): Promise<TaskRecord | null>;
}

export abstract class BackgroundUpdateRepository {
  abstract create(update: Omit<BackgroundUpdateRecord, 'deliveryToken' | 'deliveryFrom' | 'deliveredTurnId' | 'deliveredAt' | 'readAt'>): Promise<BackgroundUpdateRecord>;
  abstract get(id: string): Promise<BackgroundUpdateRecord | null>;
  abstract listByConversation(conversationId: string, options?: { delivery?: DeliveryState[] }): Promise<BackgroundUpdateRecord[]>;
  /** held -> queued (spoken in a call). */
  abstract queue(id: string): Promise<boolean>;
  /** Claims every `held` update of the conversation for a text turn: held -> inflight with `token`. */
  abstract claimHeld(conversationId: string, token: string): Promise<BackgroundUpdateRecord[]>;
  /** Claims one `queued` update for a spoken voice update: queued -> inflight. */
  abstract claimQueued(id: string, token: string): Promise<BackgroundUpdateRecord | null>;
  /** inflight(token) -> delivered. */
  abstract complete(token: string, turnId: string, at: string): Promise<number>;
  /** inflight(token) -> its `deliveryFrom` state. */
  abstract rollback(token: string): Promise<number>;
  /** Boot recovery: every inflight update returns to its `deliveryFrom` state. */
  abstract revertInflight(): Promise<number>;
  /** queued -> held for a conversation whose call ended. */
  abstract unqueue(conversationId: string, ids: string[]): Promise<number>;
  abstract markRead(conversationId: string, ids: string[], at: string): Promise<number>;
  abstract unreadCount(conversationId: string): Promise<number>;
}

export abstract class McpSettingsRepository {
  /** Null before the first save (empty list). */
  abstract get(): Promise<McpSettingsRecord | null>;
  /** Compare-and-set on `expectedRevision` (null = no settings yet). Throws `ConflictError('revision_conflict')`. */
  abstract save(record: Omit<McpSettingsRecord, 'updatedAt'>, expectedRevision: string | null): Promise<McpSettingsRecord>;
}

export abstract class AppStateRepository {
  abstract get<T>(key: AppStateKey): Promise<T | null>;
  abstract set<T>(key: AppStateKey, value: T): Promise<void>;
  /** Atomically replace and return the previous value. */
  abstract swap<T>(key: AppStateKey, value: T): Promise<T | null>;
}

export abstract class MemoryRetentionRepository {
  /** Creates the retention and marks its turns analyzed in one transaction. */
  abstract createForTurns(record: Omit<MemoryRetentionRecord, 'status' | 'attempts' | 'error' | 'submittedAt' | 'createdAt'>): Promise<MemoryRetentionRecord>;
  abstract listPending(limit: number): Promise<MemoryRetentionRecord[]>;
  abstract markSubmitted(id: string, at: string): Promise<void>;
  abstract markAttemptFailed(id: string, error: string, terminal: boolean): Promise<void>;
}

export abstract class RecallLedgerRepository {
  /** Memory ids already injected into this conversation (avoid repeating them). */
  abstract injectedIds(conversationId: string): Promise<Set<string>>;
  abstract record(conversationId: string, turnId: string, memoryIds: string[]): Promise<void>;
}

/** Every repository, bound to one connection or transaction. */
export interface Repositories {
  conversations: ConversationRepository;
  promptSnapshots: PromptSnapshotRepository;
  turns: TurnRepository;
  messages: MessageRepository;
  toolCalls: ToolCallRepository;
  tasks: TaskRepository;
  updates: BackgroundUpdateRepository;
  mcpSettings: McpSettingsRepository;
  appState: AppStateRepository;
  memoryRetentions: MemoryRetentionRepository;
  recallLedger: RecallLedgerRepository;
}

/** Storage entry point: repositories plus transactions, migrations and lifecycle. */
export abstract class Storage implements Repositories {
  abstract readonly conversations: ConversationRepository;
  abstract readonly promptSnapshots: PromptSnapshotRepository;
  abstract readonly turns: TurnRepository;
  abstract readonly messages: MessageRepository;
  abstract readonly toolCalls: ToolCallRepository;
  abstract readonly tasks: TaskRepository;
  abstract readonly updates: BackgroundUpdateRepository;
  abstract readonly mcpSettings: McpSettingsRepository;
  abstract readonly appState: AppStateRepository;
  abstract readonly memoryRetentions: MemoryRetentionRepository;
  abstract readonly recallLedger: RecallLedgerRepository;

  /** Run `fn` in one transaction (serializable where state machines need it). */
  abstract transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T>;
  /** Apply pending migrations (idempotent, advisory-locked). */
  abstract migrate(): Promise<string[]>;
  abstract healthy(): Promise<boolean>;
  abstract close(): Promise<void>;
}
