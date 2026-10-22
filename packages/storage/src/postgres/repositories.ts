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
import type { QueryResultRow } from 'pg';
import {
  type BackgroundUpdateRow,
  type McpSettingsRow,
  type MemoryRetentionRow,
  type MessageRow,
  type PromptSnapshotRow,
  type TaskRow,
  type ToolCallRow,
  type TurnRow,
  jsonParam,
  toBackgroundUpdate,
  toConversation,
  toMcpSettings,
  toMemoryRetention,
  toMessage,
  toPromptSnapshot,
  toTask,
  toToolCall,
  toTurn,
} from './mappers.ts';
import type { PgSession } from './session.ts';

/* ---------- helpers ---------- */

async function rowsOf<R extends QueryResultRow, T>(session: PgSession, text: string, values: unknown[], map: (row: R) => T): Promise<T[]> {
  const { rows } = await session.query<R>(text, values);
  return rows.map(map);
}

async function rowOf<R extends QueryResultRow, T>(session: PgSession, text: string, values: unknown[], map: (row: R) => T): Promise<T | null> {
  const [row] = await rowsOf<R, T>(session, text, values, map);
  return row ?? null;
}

async function affected(session: PgSession, text: string, values: unknown[]): Promise<number> {
  const result = await session.query(text, values);
  return result.rowCount ?? 0;
}

/** For statements that must return a row (INSERT ... RETURNING). */
function requireOne<T>(rows: T[], what: string): T {
  const [row] = rows;
  if (row === undefined) throw new Error(`expected ${what} row`);
  return row;
}

async function requireAffected(session: PgSession, text: string, values: unknown[], what: string): Promise<void> {
  if ((await affected(session, text, values)) === 0) throw new NotFoundError(what);
}

async function lockConversation(session: PgSession, conversationId: string): Promise<void> {
  const { rows } = await session.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
  if (rows.length === 0) throw new NotFoundError('conversation');
}

function pageOf<T extends { id: string }>(fetched: T[], limit: number): Page<T> {
  const items = fetched.slice(0, limit);
  return { items, nextCursor: fetched.length > limit ? (items.at(-1)?.id ?? null) : null };
}

/** Orders by creation time, then id, with plain code-point comparison (same as the in-memory fake). */
function byCreated<T extends { createdAt: string; id: string }>(rows: T[]): T[] {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return rows.sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
}

async function insertSnapshot(session: PgSession, snapshot: Omit<PromptSnapshotRecord, 'id' | 'createdAt'>): Promise<PromptSnapshotRecord> {
  return requireOne(
    await rowsOf(
      session,
      `INSERT INTO prompt_snapshots (id, owner_kind, owner_id, system_prompt, tools, template_id, template_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [uuid(), snapshot.ownerKind, snapshot.ownerId, snapshot.systemPrompt, jsonParam(snapshot.tools), snapshot.templateId, snapshot.templateHash],
      toPromptSnapshot
    ),
    'prompt snapshot'
  );
}

/* ---------- repositories ---------- */

export class PgConversationRepository extends ConversationRepository {
  constructor(private readonly session: PgSession) {
    super();
  }

  create(
    conversation: Pick<ConversationRecord, 'id' | 'title' | 'titleSource'>,
    snapshot: Omit<PromptSnapshotRecord, 'id' | 'ownerKind' | 'ownerId' | 'createdAt'>
  ): Promise<ConversationRecord> {
    return this.session.transaction(async (tx) => {
      const record = requireOne(
        await rowsOf(
          tx,
          'INSERT INTO conversations (id, title, title_source) VALUES ($1, $2, $3) RETURNING *',
          [conversation.id, conversation.title, conversation.titleSource],
          toConversation
        ),
        'conversation'
      );
      await insertSnapshot(tx, { ...snapshot, ownerKind: 'conversation', ownerId: record.id });
      return record;
    });
  }

  get(id: string, options?: { includeArchived?: boolean }): Promise<ConversationRecord | null> {
    return rowOf(
      this.session,
      'SELECT * FROM conversations WHERE id = $1 AND ($2::boolean OR archived_at IS NULL)',
      [id, options?.includeArchived === true],
      toConversation
    );
  }

  async list(options: { limit: number; after?: string }): Promise<Page<ConversationRecord>> {
    const fetched = await rowsOf(
      this.session,
      `SELECT * FROM conversations
       WHERE archived_at IS NULL
         AND ($2::uuid IS NULL OR (coalesce(last_message_at, created_at), id) < (
           SELECT coalesce(c.last_message_at, c.created_at), c.id FROM conversations c WHERE c.id = $2::uuid))
       ORDER BY coalesce(last_message_at, created_at) DESC, id DESC
       LIMIT $1`,
      [options.limit + 1, options.after ?? null],
      toConversation
    );
    return pageOf(fetched, options.limit);
  }

  rename(id: string, title: string, source: 'auto' | 'user'): Promise<ConversationRecord | null> {
    return rowOf(
      this.session,
      'UPDATE conversations SET title = $2, title_source = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [id, title, source],
      toConversation
    );
  }

  async setTitleIfUntitled(id: string, title: string): Promise<boolean> {
    return (
      (await affected(
        this.session,
        `UPDATE conversations SET title = $2, title_source = 'auto', updated_at = now()
         WHERE id = $1 AND title_source IS NULL`,
        [id, title]
      )) > 0
    );
  }

  async archive(id: string): Promise<boolean> {
    return (
      (await affected(this.session, 'UPDATE conversations SET archived_at = now() WHERE id = $1 AND archived_at IS NULL', [id])) > 0
    );
  }

  async touch(id: string, at: string): Promise<void> {
    await requireAffected(
      this.session,
      'UPDATE conversations SET last_message_at = $2, updated_at = $2 WHERE id = $1',
      [id, at],
      'conversation'
    );
  }

  async setMcpToolNamesShown(id: string, names: string[]): Promise<void> {
    await requireAffected(this.session, 'UPDATE conversations SET mcp_tool_names_shown = $2 WHERE id = $1', [id, names], 'conversation');
  }
}

export class PgPromptSnapshotRepository extends PromptSnapshotRepository {
  constructor(private readonly session: PgSession) {
    super();
  }

  create(snapshot: Omit<PromptSnapshotRecord, 'id' | 'createdAt'>): Promise<PromptSnapshotRecord> {
    return insertSnapshot(this.session, snapshot);
  }

  getForOwner(ownerKind: PromptSnapshotRecord['ownerKind'], ownerId: string): Promise<PromptSnapshotRecord | null> {
    return rowOf<PromptSnapshotRow, PromptSnapshotRecord>(
      this.session,
      'SELECT * FROM prompt_snapshots WHERE owner_kind = $1 AND owner_id = $2',
      [ownerKind, ownerId],
      toPromptSnapshot
    );
  }
}

export class PgTurnRepository extends TurnRepository {
  constructor(private readonly session: PgSession) {
    super();
  }

  create(turn: Omit<TurnRecord, 'seq' | 'endedAt' | 'memoryRetentionId' | 'usage' | 'recall' | 'error'>): Promise<TurnRecord> {
    return this.session.transaction(async (tx) => {
      await lockConversation(tx, turn.conversationId);
      return requireOne(
        await rowsOf(
          tx,
          `INSERT INTO turns (id, conversation_id, seq, kind, modality, mode, effort, status, client_message_id, model, started_at)
           VALUES ($1, $2, (SELECT coalesce(max(seq), 0) + 1 FROM turns WHERE conversation_id = $2), $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            turn.id,
            turn.conversationId,
            turn.kind,
            turn.modality,
            turn.mode,
            turn.effort,
            turn.status,
            turn.clientMessageId,
            turn.model,
            turn.startedAt,
          ],
          toTurn
        ),
        'turn'
      );
    });
  }

  get(id: string): Promise<TurnRecord | null> {
    return rowOf<TurnRow, TurnRecord>(this.session, 'SELECT * FROM turns WHERE id = $1', [id], toTurn);
  }

  async finish(id: string, patch: Parameters<TurnRepository['finish']>[1]): Promise<void> {
    await requireAffected(
      this.session,
      'UPDATE turns SET status = $2, error = $3, usage = $4, model = $5, ended_at = $6 WHERE id = $1',
      [id, patch.status, patch.error, jsonParam(patch.usage), patch.model, patch.endedAt],
      'turn'
    );
  }

  async setRecall(id: string, recall: NonNullable<TurnRecord['recall']>): Promise<void> {
    await requireAffected(this.session, 'UPDATE turns SET recall = $2 WHERE id = $1', [id, jsonParam(recall)], 'turn');
  }

  listUnanalyzed(conversationId: string): Promise<TurnRecord[]> {
    return rowsOf(
      this.session,
      `SELECT * FROM turns WHERE conversation_id = $1 AND memory_retention_id IS NULL AND status = 'completed' ORDER BY seq`,
      [conversationId],
      toTurn
    );
  }

  async markAnalyzed(turnIds: string[], retentionId: string): Promise<void> {
    await this.session.query('UPDATE turns SET memory_retention_id = $2 WHERE id = ANY($1::uuid[])', [turnIds, retentionId]);
  }

  async failRunning(reason: string): Promise<string[]> {
    const { rows } = await this.session.query<{ id: string }>(
      `UPDATE turns SET status = 'failed', error = $1, ended_at = now() WHERE status = 'running' RETURNING id`,
      [reason]
    );
    return rows.map((row) => row.id);
  }

  latestWithUsage(conversationId: string): Promise<TurnRecord | null> {
    return rowOf(
      this.session,
      `SELECT * FROM turns WHERE conversation_id = $1 AND status = 'completed' AND usage IS NOT NULL ORDER BY seq DESC LIMIT 1`,
      [conversationId],
      toTurn
    );
  }
}

export class PgMessageRepository extends MessageRepository {
  constructor(private readonly session: PgSession) {
    super();
  }

  append(message: Omit<MessageRecord, 'seq' | 'createdAt' | 'deletedAt'>): Promise<MessageRecord> {
    return this.session.transaction(async (tx) => {
      await lockConversation(tx, message.conversationId);
      return requireOne(
        await rowsOf(
          tx,
          `INSERT INTO messages (id, conversation_id, task_id, turn_id, seq, role, content, envelope, provider, model,
                                 provider_message_id, stop_reason, usage, timings)
           VALUES ($1, $2, $3::text, $4::uuid,
                   (SELECT coalesce(max(seq), 0) + 1 FROM messages WHERE conversation_id = $2 AND coalesce(task_id, '') = coalesce($3::text, '')),
                   $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12::jsonb, $13::jsonb)
           RETURNING *`,
          [
            message.id,
            message.conversationId,
            message.taskId,
            message.turnId,
            message.role,
            jsonParam(message.content),
            jsonParam(message.envelope),
            message.provider,
            message.model,
            message.providerMessageId,
            message.stopReason,
            jsonParam(message.usage),
            jsonParam(message.timings),
          ],
          toMessage
        ),
        'message'
      );
    });
  }

  transcript(conversationId: string, taskId: string | null): Promise<MessageRecord[]> {
    return rowsOf(
      this.session,
      `SELECT * FROM messages
       WHERE conversation_id = $1 AND coalesce(task_id, '') = coalesce($2::text, '') AND deleted_at IS NULL
       ORDER BY seq`,
      [conversationId, taskId],
      toMessage
    );
  }

  async page(conversationId: string, options: { before?: string; limit: number }): Promise<Page<MessageRecord>> {
    const fetched = await rowsOf(
      this.session,
      `SELECT * FROM messages
       WHERE conversation_id = $1 AND task_id IS NULL AND deleted_at IS NULL
         AND ($2::uuid IS NULL OR seq < (SELECT m.seq FROM messages m WHERE m.id = $2::uuid))
       ORDER BY seq DESC
       LIMIT $3`,
      [conversationId, options.before ?? null, options.limit + 1],
      toMessage
    );
    return pageOf(fetched, options.limit);
  }

  get(id: string): Promise<MessageRecord | null> {
    return rowOf<MessageRow, MessageRecord>(this.session, 'SELECT * FROM messages WHERE id = $1', [id], toMessage);
  }

  softDeleteFrom(conversationId: string, messageId: string): Promise<number> {
    return this.session.transaction(async (tx) => {
      const [target] = await rowsOf(
        tx,
        'SELECT seq, task_id FROM messages WHERE id = $1 AND conversation_id = $2',
        [messageId, conversationId],
        (row: { seq: string; task_id: string | null }) => ({ seq: Number(row.seq), taskId: row.task_id })
      );
      if (target === undefined) throw new NotFoundError('message');
      return affected(
        tx,
        `UPDATE messages SET deleted_at = now()
         WHERE conversation_id = $1 AND deleted_at IS NULL AND coalesce(task_id, '') = coalesce($2::text, '') AND seq >= $3`,
        [conversationId, target.taskId, target.seq]
      );
    });
  }
}

export class PgToolCallRepository extends ToolCallRepository {
  constructor(private readonly session: PgSession) {
    super();
  }

  async start(call: Omit<ToolCallRecord, 'status' | 'resultText' | 'isError' | 'display' | 'taskRef' | 'endedAt'>): Promise<void> {
    await this.session.query(
      `INSERT INTO tool_calls (id, conversation_id, task_id, turn_id, assistant_message_id, name, input, status, is_error, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'running', false, $8)`,
      [call.id, call.conversationId, call.taskId, call.turnId, call.assistantMessageId, call.name, jsonParam(call.input), call.startedAt]
    );
  }

  async finish(id: string, patch: Parameters<ToolCallRepository['finish']>[1]): Promise<void> {
    await requireAffected(
      this.session,
      `UPDATE tool_calls SET status = $2, result_text = $3, is_error = $4, display = $5::jsonb, task_ref = $6::jsonb, ended_at = $7
       WHERE id = $1`,
      [id, patch.status, patch.resultText, patch.isError, jsonParam(patch.display), jsonParam(patch.taskRef), patch.endedAt],
      'tool call'
    );
  }

  async listForMessages(messageIds: string[]): Promise<ToolCallRecord[]> {
    if (messageIds.length === 0) return [];
    return rowsOf<ToolCallRow, ToolCallRecord>(
      this.session,
      'SELECT * FROM tool_calls WHERE assistant_message_id = ANY($1::uuid[]) ORDER BY started_at, id',
      [messageIds],
      toToolCall
    );
  }

  cancelRunning(reason: string): Promise<number> {
    return affected(
      this.session,
      `UPDATE tool_calls SET status = 'cancelled', result_text = $1, is_error = true, ended_at = now() WHERE status = 'running'`,
      [reason]
    );
  }
}

export class PgTaskRepository extends TaskRepository {
  constructor(private readonly session: PgSession) {
    super();
  }

  create(task: Omit<TaskRecord, 'endedAt' | 'stopRequestedAt' | 'exitCode' | 'stdoutTail' | 'stderrTail' | 'report' | 'usage'>): Promise<TaskRecord> {
    return rowsOf<TaskRow, TaskRecord>(
      this.session,
      `INSERT INTO tasks (id, conversation_id, kind, status, title, prompt, subagent_type, command, cwd, output_path,
                          needs_input, origin_mode, origin_turn_id, origin_tool_call_id, parent_task_id,
                          resumed_from_task_id, depth, model, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [
        task.id,
        task.conversationId,
        task.kind,
        task.status,
        task.title,
        task.prompt,
        task.subagentType,
        task.command,
        task.cwd,
        task.outputPath,
        task.needsInput,
        task.originMode,
        task.originTurnId,
        task.originToolCallId,
        task.parentTaskId,
        task.resumedFromTaskId,
        task.depth,
        task.model,
        task.startedAt,
      ],
      toTask
    ).then((rows) => requireOne(rows, 'task'));
  }

  get(id: string): Promise<TaskRecord | null> {
    return rowOf<TaskRow, TaskRecord>(this.session, 'SELECT * FROM tasks WHERE id = $1', [id], toTask);
  }

  listByConversation(conversationId: string, options?: { limit?: number }): Promise<TaskRecord[]> {
    return rowsOf<TaskRow, TaskRecord>(
      this.session,
      'SELECT * FROM tasks WHERE conversation_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2',
      [conversationId, options?.limit ?? null],
      toTask
    );
  }

  listRunning(conversationId?: string): Promise<TaskRecord[]> {
    return rowsOf<TaskRow, TaskRecord>(
      this.session,
      `SELECT * FROM tasks WHERE status = 'running' AND ($1::uuid IS NULL OR conversation_id = $1::uuid) ORDER BY started_at, id`,
      [conversationId ?? null],
      toTask
    );
  }

  async updateProgress(id: string, patch: Partial<Pick<TaskRecord, 'stdoutTail' | 'stderrTail' | 'usage' | 'outputPath'>>): Promise<void> {
    const assignments: Array<[string, unknown]> = [];
    if (patch.stdoutTail !== undefined) assignments.push(['stdout_tail', patch.stdoutTail]);
    if (patch.stderrTail !== undefined) assignments.push(['stderr_tail', patch.stderrTail]);
    if (patch.usage !== undefined) assignments.push(['usage', jsonParam(patch.usage)]);
    if (patch.outputPath !== undefined) assignments.push(['output_path', patch.outputPath]);

    if (assignments.length === 0) {
      if ((await this.get(id)) === null) throw new NotFoundError('task');
      return;
    }
    const sets = assignments.map(([column], index) => `${column} = $${index + 2}`).join(', ');
    await requireAffected(
      this.session,
      `UPDATE tasks SET ${sets} WHERE id = $1`,
      [id, ...assignments.map(([, value]) => value)],
      'task'
    );
  }

  async requestStop(id: string, at: string): Promise<void> {
    await requireAffected(
      this.session,
      'UPDATE tasks SET stop_requested_at = coalesce(stop_requested_at, $2) WHERE id = $1',
      [id, at],
      'task'
    );
  }

  /** Only a running task transitions; a finished one returns null. */
  finish(id: string, patch: Parameters<TaskRepository['finish']>[1]): Promise<TaskRecord | null> {
    return rowOf<TaskRow, TaskRecord>(
      this.session,
      `UPDATE tasks SET status = $2, report = $3, needs_input = $4, exit_code = $5, stdout_tail = $6, stderr_tail = $7,
                        usage = $8::jsonb, ended_at = $9
       WHERE id = $1 AND status = 'running'
       RETURNING *`,
      [id, patch.status, patch.report, patch.needsInput, patch.exitCode, patch.stdoutTail, patch.stderrTail, jsonParam(patch.usage), patch.endedAt],
      toTask
    );
  }
}

export class PgBackgroundUpdateRepository extends BackgroundUpdateRepository {
  constructor(private readonly session: PgSession) {
    super();
  }

  create(update: Omit<BackgroundUpdateRecord, 'deliveryToken' | 'deliveryFrom' | 'deliveredTurnId' | 'deliveredAt' | 'readAt'>): Promise<BackgroundUpdateRecord> {
    return rowsOf<BackgroundUpdateRow, BackgroundUpdateRecord>(
      this.session,
      `INSERT INTO background_updates (id, conversation_id, task_id, title, status, needs_input, report, duration_ms,
                                      depth, delivery, unread, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        update.id,
        update.conversationId,
        update.taskId,
        update.title,
        update.status,
        update.needsInput,
        update.report,
        update.durationMs,
        update.depth,
        update.delivery,
        update.unread,
        update.createdAt,
      ],
      toBackgroundUpdate
    ).then((rows) => requireOne(rows, 'background update'));
  }

  get(id: string): Promise<BackgroundUpdateRecord | null> {
    return rowOf<BackgroundUpdateRow, BackgroundUpdateRecord>(this.session, 'SELECT * FROM background_updates WHERE id = $1', [id], toBackgroundUpdate);
  }

  async listByConversation(conversationId: string, options?: { delivery?: DeliveryState[] }): Promise<BackgroundUpdateRecord[]> {
    return byCreated(
      await rowsOf<BackgroundUpdateRow, BackgroundUpdateRecord>(
        this.session,
        `SELECT * FROM background_updates
         WHERE conversation_id = $1 AND ($2::text[] IS NULL OR delivery = ANY($2::text[]))
         ORDER BY created_at, id`,
        [conversationId, options?.delivery ?? null],
        toBackgroundUpdate
      )
    );
  }

  async queue(id: string): Promise<boolean> {
    return (await affected(this.session, `UPDATE background_updates SET delivery = 'queued' WHERE id = $1 AND delivery = 'held'`, [id])) > 0;
  }

  async claimHeld(conversationId: string, token: string): Promise<BackgroundUpdateRecord[]> {
    return byCreated(
      await rowsOf<BackgroundUpdateRow, BackgroundUpdateRecord>(
        this.session,
        `UPDATE background_updates SET delivery = 'inflight', delivery_token = $2, delivery_from = 'held'
         WHERE conversation_id = $1 AND delivery = 'held'
         RETURNING *`,
        [conversationId, token],
        toBackgroundUpdate
      )
    );
  }

  claimQueued(id: string, token: string): Promise<BackgroundUpdateRecord | null> {
    return rowOf<BackgroundUpdateRow, BackgroundUpdateRecord>(
      this.session,
      `UPDATE background_updates SET delivery = 'inflight', delivery_token = $2, delivery_from = 'queued'
       WHERE id = $1 AND delivery = 'queued'
       RETURNING *`,
      [id, token],
      toBackgroundUpdate
    );
  }

  complete(token: string, turnId: string, at: string): Promise<number> {
    return affected(
      this.session,
      `UPDATE background_updates SET delivery = 'delivered', delivered_turn_id = $2, delivered_at = $3,
                                    delivery_token = NULL, delivery_from = NULL
       WHERE delivery = 'inflight' AND delivery_token = $1`,
      [token, turnId, at]
    );
  }

  rollback(token: string): Promise<number> {
    return affected(
      this.session,
      `UPDATE background_updates SET delivery = coalesce(delivery_from, 'held'), delivery_token = NULL, delivery_from = NULL
       WHERE delivery = 'inflight' AND delivery_token = $1`,
      [token]
    );
  }

  revertInflight(): Promise<number> {
    return affected(
      this.session,
      `UPDATE background_updates SET delivery = coalesce(delivery_from, 'held'), delivery_token = NULL, delivery_from = NULL
       WHERE delivery = 'inflight'`,
      []
    );
  }

  unqueue(conversationId: string, ids: string[]): Promise<number> {
    return affected(
      this.session,
      `UPDATE background_updates SET delivery = 'held'
       WHERE conversation_id = $1 AND id = ANY($2::uuid[]) AND delivery = 'queued'`,
      [conversationId, ids]
    );
  }

  /** Counts (and marks) only updates that were unread. */
  markRead(conversationId: string, ids: string[], at: string): Promise<number> {
    return affected(
      this.session,
      `UPDATE background_updates SET unread = false, read_at = $3
       WHERE conversation_id = $1 AND id = ANY($2::uuid[]) AND unread`,
      [conversationId, ids, at]
    );
  }

  async unreadCount(conversationId: string): Promise<number> {
    const { rows } = await this.session.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM background_updates WHERE conversation_id = $1 AND unread',
      [conversationId]
    );
    return rows[0]?.count ?? 0;
  }
}

export class PgMcpSettingsRepository extends McpSettingsRepository {
  constructor(private readonly session: PgSession) {
    super();
  }

  get(): Promise<McpSettingsRecord | null> {
    return rowOf<McpSettingsRow, McpSettingsRecord>(this.session, 'SELECT * FROM mcp_settings WHERE id = 1', [], toMcpSettings);
  }

  async save(record: Omit<McpSettingsRecord, 'updatedAt'>, expectedRevision: string | null): Promise<McpSettingsRecord> {
    const values = [jsonParam(record.servers), jsonParam(record.invalidEntries), record.revision];
    const saved =
      expectedRevision === null
        ? await rowOf<McpSettingsRow, McpSettingsRecord>(
            this.session,
            `INSERT INTO mcp_settings (id, servers, invalid_entries, revision) VALUES (1, $1, $2, $3)
             ON CONFLICT (id) DO NOTHING RETURNING *`,
            values,
            toMcpSettings
          )
        : await rowOf<McpSettingsRow, McpSettingsRecord>(
            this.session,
            `UPDATE mcp_settings SET servers = $1, invalid_entries = $2, revision = $3, updated_at = now()
             WHERE id = 1 AND revision = $4 RETURNING *`,
            [...values, expectedRevision],
            toMcpSettings
          );
    if (saved === null) {
      throw new ConflictError('revision_conflict', 'MCP settings were changed by another save; reload and retry');
    }
    return saved;
  }
}

export class PgAppStateRepository extends AppStateRepository {
  constructor(private readonly session: PgSession) {
    super();
  }

  async get<T>(key: AppStateKey): Promise<T | null> {
    const { rows } = await this.session.query<{ value: T | null }>('SELECT value FROM app_state WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  async set<T>(key: AppStateKey, value: T): Promise<void> {
    await this.session.query(
      `INSERT INTO app_state (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value) ?? 'null']
    );
  }

  swap<T>(key: AppStateKey, value: T): Promise<T | null> {
    return this.session.transaction(async (tx) => {
      const repo = new PgAppStateRepository(tx);
      const previous = await repo.get<T>(key);
      await repo.set(key, value);
      return previous;
    });
  }
}

export class PgMemoryRetentionRepository extends MemoryRetentionRepository {
  constructor(private readonly session: PgSession) {
    super();
  }

  createForTurns(record: Omit<MemoryRetentionRecord, 'status' | 'attempts' | 'error' | 'submittedAt' | 'createdAt'>): Promise<MemoryRetentionRecord> {
    return this.session.transaction(async (tx) => {
      const row = requireOne(
        await rowsOf<MemoryRetentionRow, MemoryRetentionRecord>(
          tx,
          `INSERT INTO memory_retentions (id, conversation_id, turn_ids, document_id, operation_id, reason, status, attempts, created_at)
           VALUES ($1, $2, $3::uuid[], $4, $5, $6, 'pending', 0, now())
           RETURNING *`,
          [record.id, record.conversationId, record.turnIds, record.documentId, record.operationId, record.reason],
          toMemoryRetention
        ),
        'memory retention'
      );
      await tx.query(
        'UPDATE turns SET memory_retention_id = $1 WHERE conversation_id = $2 AND id = ANY($3::uuid[])',
        [row.id, record.conversationId, record.turnIds]
      );
      return row;
    });
  }

  listPending(limit: number): Promise<MemoryRetentionRecord[]> {
    return rowsOf<MemoryRetentionRow, MemoryRetentionRecord>(
      this.session,
      `SELECT * FROM memory_retentions WHERE status = 'pending' ORDER BY created_at, id LIMIT $1`,
      [limit],
      toMemoryRetention
    );
  }

  async markSubmitted(id: string, at: string): Promise<void> {
    await requireAffected(
      this.session,
      `UPDATE memory_retentions SET status = 'submitted', submitted_at = $2, error = NULL WHERE id = $1`,
      [id, at],
      'memory retention'
    );
  }

  async markAttemptFailed(id: string, error: string, terminal: boolean): Promise<void> {
    await requireAffected(
      this.session,
      `UPDATE memory_retentions SET attempts = attempts + 1, error = $2,
                                    status = CASE WHEN $3::boolean THEN 'failed' ELSE status END
       WHERE id = $1`,
      [id, error, terminal],
      'memory retention'
    );
  }
}

export class PgRecallLedgerRepository extends RecallLedgerRepository {
  constructor(private readonly session: PgSession) {
    super();
  }

  async injectedIds(conversationId: string): Promise<Set<string>> {
    const { rows } = await this.session.query<{ memory_id: string }>(
      'SELECT memory_id FROM conversation_recalls WHERE conversation_id = $1',
      [conversationId]
    );
    return new Set(rows.map((row) => row.memory_id));
  }

  async record(conversationId: string, turnId: string, memoryIds: string[]): Promise<void> {
    await this.session.query(
      `INSERT INTO conversation_recalls (conversation_id, memory_id, turn_id)
       SELECT $1::uuid, memory_id, $2::uuid FROM unnest($3::text[]) AS memory_id
       ON CONFLICT (conversation_id, memory_id) DO NOTHING`,
      [conversationId, turnId, memoryIds]
    );
  }
}

/** All repositories bound to one session (the pool, or one transaction's client). */
export class PgRepositories implements Repositories {
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

  constructor(session: PgSession) {
    this.conversations = new PgConversationRepository(session);
    this.promptSnapshots = new PgPromptSnapshotRepository(session);
    this.turns = new PgTurnRepository(session);
    this.messages = new PgMessageRepository(session);
    this.toolCalls = new PgToolCallRepository(session);
    this.tasks = new PgTaskRepository(session);
    this.updates = new PgBackgroundUpdateRepository(session);
    this.mcpSettings = new PgMcpSettingsRepository(session);
    this.appState = new PgAppStateRepository(session);
    this.memoryRetentions = new PgMemoryRetentionRepository(session);
    this.recallLedger = new PgRecallLedgerRepository(session);
  }
}
