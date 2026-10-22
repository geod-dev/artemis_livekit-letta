import { ConflictError, NotFoundError, uuid } from '@artemis/core';
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
} from '../domain.ts';
import {
  AppStateRepository,
  BackgroundUpdateRepository,
  ConversationRepository,
  McpSettingsRepository,
  MemoryRetentionRepository,
  MessageRepository,
  type Page,
  PromptSnapshotRepository,
  RecallLedgerRepository,
  type Repositories,
  TaskRepository,
  ToolCallRepository,
  TurnRepository,
} from '../repositories.ts';
import { type MemoryAccess, type MemoryState } from './database.ts';

const copy = <T>(value: T): T => structuredClone(value);

function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new NotFoundError(what);
  return row;
}

function requireRef(exists: boolean, what: string): void {
  if (!exists) throw new NotFoundError(what);
}

function paginate<T extends { id: string }>(items: T[], limit: number): Page<T> {
  const page = items.slice(0, limit);
  return { items: page, nextCursor: items.length > limit ? (page.at(-1)?.id ?? null) : null };
}

/** 1 + the largest `seq` among the rows that match (tables allocate seq per scope, never reuse it). */
function nextSeq<T>(rows: Iterable<T>, matches: (row: T) => boolean, seqOf: (row: T) => number): number {
  let max = 0;
  for (const row of rows) if (matches(row)) max = Math.max(max, seqOf(row));
  return max + 1;
}

/** Plain code-point comparison: ids and ISO timestamps must order the same everywhere. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Listing order of conversations: most recent activity first, then id descending. */
function recentKey(conversation: ConversationRecord): string {
  return conversation.lastMessageAt ?? conversation.createdAt;
}

function compareRecent(a: ConversationRecord, b: ConversationRecord): number {
  const byKey = compareText(recentKey(b), recentKey(a));
  return byKey !== 0 ? byKey : compareText(b.id, a.id);
}

function compareByCreated<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  return compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id);
}

function insertSnapshot(
  state: MemoryState,
  snapshot: Omit<PromptSnapshotRecord, 'id' | 'createdAt'>,
  createdAt: string
): PromptSnapshotRecord {
  const duplicate = [...state.promptSnapshots.values()].some(
    (row) => row.ownerKind === snapshot.ownerKind && row.ownerId === snapshot.ownerId
  );
  if (duplicate) throw new ConflictError('duplicate_key', `prompt snapshot for ${snapshot.ownerKind} ${snapshot.ownerId} exists`);
  const record: PromptSnapshotRecord = { ...copy(snapshot), id: uuid(), createdAt };
  state.promptSnapshots.set(record.id, record);
  return record;
}

export class MemoryConversationRepository extends ConversationRepository {
  constructor(private readonly access: MemoryAccess) {
    super();
  }

  create(
    conversation: Pick<ConversationRecord, 'id' | 'title' | 'titleSource'>,
    snapshot: Omit<PromptSnapshotRecord, 'id' | 'ownerKind' | 'ownerId' | 'createdAt'>
  ): Promise<ConversationRecord> {
    return this.access.run((state) => {
      if (state.conversations.has(conversation.id)) {
        throw new ConflictError('duplicate_key', `conversation ${conversation.id} already exists`);
      }
      const now = this.access.now();
      const record: ConversationRecord = {
        id: conversation.id,
        title: conversation.title,
        titleSource: conversation.titleSource,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
        archivedAt: null,
        mcpToolNamesShown: null,
      };
      insertSnapshot(state, { ...copy(snapshot), ownerKind: 'conversation', ownerId: record.id }, now);
      state.conversations.set(record.id, record);
      return record;
    });
  }

  get(id: string, options?: { includeArchived?: boolean }): Promise<ConversationRecord | null> {
    return this.access.run((state) => {
      const row = state.conversations.get(id);
      if (row === undefined) return null;
      return row.archivedAt !== null && !options?.includeArchived ? null : row;
    });
  }

  list(options: { limit: number; after?: string }): Promise<Page<ConversationRecord>> {
    return this.access.run((state) => {
      const visible = [...state.conversations.values()]
        .filter((row) => row.archivedAt === null)
        .sort(compareRecent);
      let rest = visible;
      if (options.after !== undefined) {
        const cursor = state.conversations.get(options.after);
        if (cursor === undefined) return { items: [], nextCursor: null };
        rest = visible.filter((row) => compareRecent(row, cursor) > 0);
      }
      return paginate(rest, options.limit);
    });
  }

  rename(id: string, title: string, source: 'auto' | 'user'): Promise<ConversationRecord | null> {
    return this.access.run((state) => {
      const row = state.conversations.get(id);
      if (row === undefined) return null;
      Object.assign(row, { title, titleSource: source, updatedAt: this.access.now() });
      return row;
    });
  }

  setTitleIfUntitled(id: string, title: string): Promise<boolean> {
    return this.access.run((state) => {
      const row = state.conversations.get(id);
      if (row === undefined || row.titleSource !== null) return false;
      Object.assign(row, { title, titleSource: 'auto', updatedAt: this.access.now() });
      return true;
    });
  }

  archive(id: string): Promise<boolean> {
    return this.access.run((state) => {
      const row = state.conversations.get(id);
      if (row === undefined || row.archivedAt !== null) return false;
      row.archivedAt = this.access.now();
      return true;
    });
  }

  touch(id: string, at: string): Promise<void> {
    return this.access.run((state) => {
      const row = requireRow(state.conversations.get(id), 'conversation');
      Object.assign(row, { lastMessageAt: at, updatedAt: at });
    });
  }

  setMcpToolNamesShown(id: string, names: string[]): Promise<void> {
    return this.access.run((state) => {
      const row = requireRow(state.conversations.get(id), 'conversation');
      row.mcpToolNamesShown = copy(names);
    });
  }
}

export class MemoryPromptSnapshotRepository extends PromptSnapshotRepository {
  constructor(private readonly access: MemoryAccess) {
    super();
  }

  create(snapshot: Omit<PromptSnapshotRecord, 'id' | 'createdAt'>): Promise<PromptSnapshotRecord> {
    return this.access.run((state) => insertSnapshot(state, snapshot, this.access.now()));
  }

  getForOwner(ownerKind: PromptSnapshotRecord['ownerKind'], ownerId: string): Promise<PromptSnapshotRecord | null> {
    return this.access.run((state) => {
      return [...state.promptSnapshots.values()].find((row) => row.ownerKind === ownerKind && row.ownerId === ownerId) ?? null;
    });
  }
}

export class MemoryTurnRepository extends TurnRepository {
  constructor(private readonly access: MemoryAccess) {
    super();
  }

  create(turn: Omit<TurnRecord, 'seq' | 'endedAt' | 'memoryRetentionId' | 'usage' | 'recall' | 'error'>): Promise<TurnRecord> {
    return this.access.run((state) => {
      requireRef(state.conversations.has(turn.conversationId), 'conversation');
      const seq = nextSeq(state.turns.values(), (row) => row.conversationId === turn.conversationId, (row) => row.seq);
      const record: TurnRecord = {
        ...copy(turn),
        seq,
        endedAt: null,
        memoryRetentionId: null,
        usage: null,
        recall: null,
        error: null,
      };
      state.turns.set(record.id, record);
      return record;
    });
  }

  get(id: string): Promise<TurnRecord | null> {
    return this.access.run((state) => state.turns.get(id) ?? null);
  }

  finish(id: string, patch: Parameters<TurnRepository['finish']>[1]): Promise<void> {
    return this.access.run((state) => {
      const row = requireRow(state.turns.get(id), 'turn');
      Object.assign(row, copy(patch));
    });
  }

  setRecall(id: string, recall: NonNullable<TurnRecord['recall']>): Promise<void> {
    return this.access.run((state) => {
      requireRow(state.turns.get(id), 'turn').recall = copy(recall);
    });
  }

  listUnanalyzed(conversationId: string): Promise<TurnRecord[]> {
    return this.access.run((state) =>
      [...state.turns.values()]
        .filter((row) => row.conversationId === conversationId && row.memoryRetentionId === null && row.status === 'completed')
        .sort((a, b) => a.seq - b.seq)
    );
  }

  /** Unknown ids are ignored, as in the SQL `WHERE id = ANY(...)` update. */
  markAnalyzed(turnIds: string[], retentionId: string): Promise<void> {
    return this.access.run((state) => {
      for (const id of turnIds) {
        const row = state.turns.get(id);
        if (row !== undefined) row.memoryRetentionId = retentionId;
      }
    });
  }

  failRunning(reason: string): Promise<string[]> {
    return this.access.run((state) => {
      const ids: string[] = [];
      for (const row of state.turns.values()) {
        if (row.status !== 'running') continue;
        Object.assign(row, { status: 'failed', error: reason, endedAt: this.access.now() });
        ids.push(row.id);
      }
      return ids;
    });
  }

  latestWithUsage(conversationId: string): Promise<TurnRecord | null> {
    return this.access.run((state) => {
      const rows = [...state.turns.values()]
        .filter((row) => row.conversationId === conversationId && row.status === 'completed' && row.usage !== null)
        .sort((a, b) => b.seq - a.seq);
      return rows[0] ?? null;
    });
  }
}

export class MemoryMessageRepository extends MessageRepository {
  constructor(private readonly access: MemoryAccess) {
    super();
  }

  append(message: Omit<MessageRecord, 'seq' | 'createdAt' | 'deletedAt'>): Promise<MessageRecord> {
    return this.access.run((state) => {
      requireRef(state.conversations.has(message.conversationId), 'conversation');
      if (message.taskId !== null) requireRef(state.tasks.has(message.taskId), 'task');
      if (message.turnId !== null) requireRef(state.turns.has(message.turnId), 'turn');
      const scope = (row: MessageRecord) => row.conversationId === message.conversationId && row.taskId === message.taskId;
      const record: MessageRecord = {
        ...copy(message),
        seq: nextSeq(state.messages.values(), scope, (row) => row.seq),
        createdAt: this.access.now(),
        deletedAt: null,
      };
      state.messages.set(record.id, record);
      return record;
    });
  }

  transcript(conversationId: string, taskId: string | null): Promise<MessageRecord[]> {
    return this.access.run((state) =>
      [...state.messages.values()]
        .filter((row) => row.conversationId === conversationId && row.taskId === taskId && row.deletedAt === null)
        .sort((a, b) => a.seq - b.seq)
    );
  }

  page(conversationId: string, options: { before?: string; limit: number }): Promise<Page<MessageRecord>> {
    return this.access.run((state) => {
      let rows = [...state.messages.values()].filter(
        (row) => row.conversationId === conversationId && row.taskId === null && row.deletedAt === null
      );
      if (options.before !== undefined) {
        const cursor = state.messages.get(options.before);
        if (cursor === undefined) return { items: [], nextCursor: null };
        rows = rows.filter((row) => row.seq < cursor.seq);
      }
      return paginate(rows.sort((a, b) => b.seq - a.seq), options.limit);
    });
  }

  get(id: string): Promise<MessageRecord | null> {
    return this.access.run((state) => state.messages.get(id) ?? null);
  }

  /** Soft-deletes the message and later messages of the same transcript (conversation or task). */
  softDeleteFrom(conversationId: string, messageId: string): Promise<number> {
    return this.access.run((state) => {
      const target = requireRow(state.messages.get(messageId), 'message');
      if (target.conversationId !== conversationId) throw new NotFoundError('message');
      const now = this.access.now();
      let count = 0;
      for (const row of state.messages.values()) {
        const sameScope = row.conversationId === conversationId && row.taskId === target.taskId;
        if (!sameScope || row.seq < target.seq || row.deletedAt !== null) continue;
        row.deletedAt = now;
        count += 1;
      }
      return count;
    });
  }
}

export class MemoryToolCallRepository extends ToolCallRepository {
  constructor(private readonly access: MemoryAccess) {
    super();
  }

  start(call: Omit<ToolCallRecord, 'status' | 'resultText' | 'isError' | 'display' | 'taskRef' | 'endedAt'>): Promise<void> {
    return this.access.run((state) => {
      requireRef(state.conversations.has(call.conversationId), 'conversation');
      requireRef(state.messages.has(call.assistantMessageId), 'message');
      if (call.taskId !== null) requireRef(state.tasks.has(call.taskId), 'task');
      if (call.turnId !== null) requireRef(state.turns.has(call.turnId), 'turn');
      state.toolCalls.set(call.id, {
        ...copy(call),
        status: 'running',
        resultText: null,
        isError: false,
        display: null,
        taskRef: null,
        endedAt: null,
      });
    });
  }

  finish(id: string, patch: Parameters<ToolCallRepository['finish']>[1]): Promise<void> {
    return this.access.run((state) => {
      Object.assign(requireRow(state.toolCalls.get(id), 'tool call'), copy(patch));
    });
  }

  listForMessages(messageIds: string[]): Promise<ToolCallRecord[]> {
    return this.access.run((state) => {
      const wanted = new Set(messageIds);
      return [...state.toolCalls.values()]
        .filter((row) => wanted.has(row.assistantMessageId))
        .sort((a, b) => compareText(a.startedAt, b.startedAt) || compareText(a.id, b.id));
    });
  }

  cancelRunning(reason: string): Promise<number> {
    return this.access.run((state) => {
      let count = 0;
      for (const row of state.toolCalls.values()) {
        if (row.status !== 'running') continue;
        Object.assign(row, { status: 'cancelled', resultText: reason, isError: true, endedAt: this.access.now() });
        count += 1;
      }
      return count;
    });
  }
}

export class MemoryTaskRepository extends TaskRepository {
  constructor(private readonly access: MemoryAccess) {
    super();
  }

  create(task: Omit<TaskRecord, 'endedAt' | 'stopRequestedAt' | 'exitCode' | 'stdoutTail' | 'stderrTail' | 'report' | 'usage'>): Promise<TaskRecord> {
    return this.access.run((state) => {
      requireRef(state.conversations.has(task.conversationId), 'conversation');
      if (task.originTurnId !== null) requireRef(state.turns.has(task.originTurnId), 'turn');
      if (task.parentTaskId !== null) requireRef(state.tasks.has(task.parentTaskId), 'task');
      if (task.resumedFromTaskId !== null) requireRef(state.tasks.has(task.resumedFromTaskId), 'task');
      const record: TaskRecord = {
        ...copy(task),
        endedAt: null,
        stopRequestedAt: null,
        exitCode: null,
        stdoutTail: null,
        stderrTail: null,
        report: null,
        usage: null,
      };
      state.tasks.set(record.id, record);
      return record;
    });
  }

  get(id: string): Promise<TaskRecord | null> {
    return this.access.run((state) => state.tasks.get(id) ?? null);
  }

  listByConversation(conversationId: string, options?: { limit?: number }): Promise<TaskRecord[]> {
    return this.access.run((state) => {
      const rows = [...state.tasks.values()]
        .filter((row) => row.conversationId === conversationId)
        .sort((a, b) => compareText(b.startedAt, a.startedAt) || compareText(b.id, a.id));
      return options?.limit === undefined ? rows : rows.slice(0, options.limit);
    });
  }

  listRunning(conversationId?: string): Promise<TaskRecord[]> {
    return this.access.run((state) =>
      [...state.tasks.values()]
        .filter((row) => row.status === 'running' && (conversationId === undefined || row.conversationId === conversationId))
        .sort((a, b) => compareText(a.startedAt, b.startedAt) || compareText(a.id, b.id))
    );
  }

  updateProgress(id: string, patch: Partial<Pick<TaskRecord, 'stdoutTail' | 'stderrTail' | 'usage' | 'outputPath'>>): Promise<void> {
    return this.access.run((state) => {
      const row = requireRow(state.tasks.get(id), 'task');
      for (const key of ['stdoutTail', 'stderrTail', 'usage', 'outputPath'] as const) {
        if (patch[key] !== undefined) Object.assign(row, { [key]: copy(patch[key]) });
      }
    });
  }

  requestStop(id: string, at: string): Promise<void> {
    return this.access.run((state) => {
      const row = requireRow(state.tasks.get(id), 'task');
      row.stopRequestedAt ??= at;
    });
  }

  /** Only a running task transitions; a finished one returns null. */
  finish(id: string, patch: Parameters<TaskRepository['finish']>[1]): Promise<TaskRecord | null> {
    return this.access.run((state) => {
      const row = state.tasks.get(id);
      if (row === undefined || row.status !== 'running') return null;
      Object.assign(row, copy(patch));
      return row;
    });
  }
}

export class MemoryBackgroundUpdateRepository extends BackgroundUpdateRepository {
  constructor(private readonly access: MemoryAccess) {
    super();
  }

  create(update: Omit<BackgroundUpdateRecord, 'deliveryToken' | 'deliveryFrom' | 'deliveredTurnId' | 'deliveredAt' | 'readAt'>): Promise<BackgroundUpdateRecord> {
    return this.access.run((state) => {
      requireRef(state.conversations.has(update.conversationId), 'conversation');
      requireRef(state.tasks.has(update.taskId), 'task');
      if ([...state.updates.values()].some((row) => row.taskId === update.taskId)) {
        throw new ConflictError('duplicate_key', `task ${update.taskId} already has an update`);
      }
      const record: BackgroundUpdateRecord = {
        ...copy(update),
        deliveryToken: null,
        deliveryFrom: null,
        deliveredTurnId: null,
        deliveredAt: null,
        readAt: null,
      };
      state.updates.set(record.id, record);
      return record;
    });
  }

  get(id: string): Promise<BackgroundUpdateRecord | null> {
    return this.access.run((state) => state.updates.get(id) ?? null);
  }

  listByConversation(conversationId: string, options?: { delivery?: DeliveryState[] }): Promise<BackgroundUpdateRecord[]> {
    return this.access.run((state) =>
      [...state.updates.values()]
        .filter((row) => row.conversationId === conversationId && (options?.delivery === undefined || options.delivery.includes(row.delivery)))
        .sort(compareByCreated)
    );
  }

  queue(id: string): Promise<boolean> {
    return this.access.run((state) => {
      const row = state.updates.get(id);
      if (row === undefined || row.delivery !== 'held') return false;
      row.delivery = 'queued';
      return true;
    });
  }

  claimHeld(conversationId: string, token: string): Promise<BackgroundUpdateRecord[]> {
    return this.access.run((state) => {
      const rows = [...state.updates.values()]
        .filter((row) => row.conversationId === conversationId && row.delivery === 'held')
        .sort(compareByCreated);
      for (const row of rows) Object.assign(row, { delivery: 'inflight', deliveryToken: token, deliveryFrom: 'held' });
      return rows;
    });
  }

  claimQueued(id: string, token: string): Promise<BackgroundUpdateRecord | null> {
    return this.access.run((state) => {
      const row = state.updates.get(id);
      if (row === undefined || row.delivery !== 'queued') return null;
      Object.assign(row, { delivery: 'inflight', deliveryToken: token, deliveryFrom: 'queued' });
      return row;
    });
  }

  complete(token: string, turnId: string, at: string): Promise<number> {
    return this.access.run((state) => {
      const rows = [...state.updates.values()].filter((row) => row.delivery === 'inflight' && row.deliveryToken === token);
      if (rows.length > 0) requireRef(state.turns.has(turnId), 'turn');
      for (const row of rows) {
        Object.assign(row, { delivery: 'delivered', deliveredTurnId: turnId, deliveredAt: at, deliveryToken: null, deliveryFrom: null });
      }
      return rows.length;
    });
  }

  rollback(token: string): Promise<number> {
    return this.access.run((state) => this.revert(state, (row) => row.deliveryToken === token));
  }

  revertInflight(): Promise<number> {
    return this.access.run((state) => this.revert(state, () => true));
  }

  unqueue(conversationId: string, ids: string[]): Promise<number> {
    return this.access.run((state) => {
      const wanted = new Set(ids);
      let count = 0;
      for (const row of state.updates.values()) {
        if (row.conversationId !== conversationId || row.delivery !== 'queued' || !wanted.has(row.id)) continue;
        row.delivery = 'held';
        count += 1;
      }
      return count;
    });
  }

  /** Counts (and marks) only updates that were unread. */
  markRead(conversationId: string, ids: string[], at: string): Promise<number> {
    return this.access.run((state) => {
      const wanted = new Set(ids);
      let count = 0;
      for (const row of state.updates.values()) {
        if (row.conversationId !== conversationId || !row.unread || !wanted.has(row.id)) continue;
        Object.assign(row, { unread: false, readAt: at });
        count += 1;
      }
      return count;
    });
  }

  unreadCount(conversationId: string): Promise<number> {
    return this.access.run((state) => [...state.updates.values()].filter((row) => row.conversationId === conversationId && row.unread).length);
  }

  private revert(state: MemoryState, matches: (row: BackgroundUpdateRecord) => boolean): number {
    let count = 0;
    for (const row of state.updates.values()) {
      if (row.delivery !== 'inflight' || !matches(row)) continue;
      Object.assign(row, { delivery: row.deliveryFrom ?? 'held', deliveryToken: null, deliveryFrom: null });
      count += 1;
    }
    return count;
  }
}

export class MemoryMcpSettingsRepository extends McpSettingsRepository {
  constructor(private readonly access: MemoryAccess) {
    super();
  }

  get(): Promise<McpSettingsRecord | null> {
    return this.access.run((state) => state.mcpSettings);
  }

  save(record: Omit<McpSettingsRecord, 'updatedAt'>, expectedRevision: string | null): Promise<McpSettingsRecord> {
    return this.access.run((state) => {
      if ((state.mcpSettings?.revision ?? null) !== expectedRevision) {
        throw new ConflictError('revision_conflict', 'MCP settings were changed by another save; reload and retry');
      }
      state.mcpSettings = { ...copy(record), updatedAt: this.access.now() };
      return state.mcpSettings;
    });
  }
}

export class MemoryAppStateRepository extends AppStateRepository {
  constructor(private readonly access: MemoryAccess) {
    super();
  }

  get<T>(key: AppStateKey): Promise<T | null> {
    return this.access.run((state) => (state.appState.get(key) as T | undefined) ?? null);
  }

  set<T>(key: AppStateKey, value: T): Promise<void> {
    return this.access.run((state) => {
      state.appState.set(key, copy(value));
    });
  }

  swap<T>(key: AppStateKey, value: T): Promise<T | null> {
    return this.access.run((state) => {
      const previous = (state.appState.get(key) as T | undefined) ?? null;
      state.appState.set(key, copy(value));
      return previous;
    });
  }
}

export class MemoryMemoryRetentionRepository extends MemoryRetentionRepository {
  constructor(private readonly access: MemoryAccess) {
    super();
  }

  createForTurns(record: Omit<MemoryRetentionRecord, 'status' | 'attempts' | 'error' | 'submittedAt' | 'createdAt'>): Promise<MemoryRetentionRecord> {
    return this.access.run((state) => {
      requireRef(state.conversations.has(record.conversationId), 'conversation');
      if ([...state.memoryRetentions.values()].some((row) => row.operationId === record.operationId)) {
        throw new ConflictError('duplicate_key', `operation ${record.operationId} already exists`);
      }
      const row: MemoryRetentionRecord = {
        ...copy(record),
        status: 'pending',
        attempts: 0,
        error: null,
        submittedAt: null,
        createdAt: this.access.now(),
      };
      state.memoryRetentions.set(row.id, row);
      for (const turnId of record.turnIds) {
        const turn = state.turns.get(turnId);
        if (turn !== undefined && turn.conversationId === record.conversationId) turn.memoryRetentionId = row.id;
      }
      return row;
    });
  }

  listPending(limit: number): Promise<MemoryRetentionRecord[]> {
    return this.access.run((state) =>
      [...state.memoryRetentions.values()]
        .filter((row) => row.status === 'pending')
        .sort(compareByCreated)
        .slice(0, limit)
    );
  }

  markSubmitted(id: string, at: string): Promise<void> {
    return this.access.run((state) => {
      Object.assign(requireRow(state.memoryRetentions.get(id), 'memory retention'), { status: 'submitted', submittedAt: at, error: null });
    });
  }

  markAttemptFailed(id: string, error: string, terminal: boolean): Promise<void> {
    return this.access.run((state) => {
      const row = requireRow(state.memoryRetentions.get(id), 'memory retention');
      row.attempts += 1;
      row.error = error;
      if (terminal) row.status = 'failed';
    });
  }
}

export class MemoryRecallLedgerRepository extends RecallLedgerRepository {
  constructor(private readonly access: MemoryAccess) {
    super();
  }

  injectedIds(conversationId: string): Promise<Set<string>> {
    return this.access.run((state) => new Set(state.recalls.get(conversationId)?.keys() ?? []));
  }

  record(conversationId: string, turnId: string, memoryIds: string[]): Promise<void> {
    return this.access.run((state) => {
      requireRef(state.conversations.has(conversationId), 'conversation');
      requireRef(state.turns.has(turnId), 'turn');
      const ledger = state.recalls.get(conversationId) ?? new Map<string, string | null>();
      state.recalls.set(conversationId, ledger);
      for (const memoryId of memoryIds) if (!ledger.has(memoryId)) ledger.set(memoryId, turnId);
    });
  }
}

/** All repositories bound to one state (the live database, or a transaction's view of it). */
export class MemoryRepositories implements Repositories {
  readonly conversations: ConversationRepository;
  readonly promptSnapshots: PromptSnapshotRepository;
  readonly turns: TurnRepository;
  readonly messages: MessageRepository;
  readonly toolCalls: ToolCallRepository;
  readonly tasks: TaskRepository;
  readonly updates: BackgroundUpdateRepository;
  readonly mcpSettings: McpSettingsRepository;
  readonly appState: AppStateRepository;
  readonly memoryRetentions: MemoryRetentionRepository;
  readonly recallLedger: RecallLedgerRepository;

  constructor(access: MemoryAccess) {
    this.conversations = new MemoryConversationRepository(access);
    this.promptSnapshots = new MemoryPromptSnapshotRepository(access);
    this.turns = new MemoryTurnRepository(access);
    this.messages = new MemoryMessageRepository(access);
    this.toolCalls = new MemoryToolCallRepository(access);
    this.tasks = new MemoryTaskRepository(access);
    this.updates = new MemoryBackgroundUpdateRepository(access);
    this.mcpSettings = new MemoryMcpSettingsRepository(access);
    this.appState = new MemoryAppStateRepository(access);
    this.memoryRetentions = new MemoryMemoryRetentionRepository(access);
    this.recallLedger = new MemoryRecallLedgerRepository(access);
  }
}
