import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictError, NotFoundError, prefixedId, uuid } from '@artemis/core';
import { Pool } from 'pg';
import type { BackgroundUpdateRecord, MemoryRetentionRecord, MessageRecord, TaskRecord, TurnRecord } from '../domain.ts';
import type { Storage } from '../repositories.ts';
import { PostgresStorage } from './index.ts';

/**
 * Behaviour only a real Postgres shows: uuid versus text column types, foreign-key actions, unique and check
 * constraints, rollback after a database error and concurrent sequence allocation. Basic CRUD semantics are
 * already covered by the shared storage contract (postgres-storage.test.ts), so they are not repeated here.
 * Runs when TEST_DATABASE_URL is set, e.g. postgres://user:pass@localhost:5432/postgres; skips otherwise.
 */
const baseUrl = process.env.TEST_DATABASE_URL;
const skip = baseUrl === undefined ? 'set TEST_DATABASE_URL to run Postgres tests' : false;

const TABLES = [
  'conversation_recalls', 'memory_retentions', 'app_state', 'mcp_settings', 'background_updates', 'tool_calls',
  'messages', 'tasks', 'turns', 'prompt_snapshots', 'conversations',
];

type TurnInput = Parameters<Storage['turns']['create']>[0];
type TaskInput = Parameters<Storage['tasks']['create']>[0];
type ToolCallInput = Parameters<Storage['toolCalls']['start']>[0];
type RetentionReason = MemoryRetentionRecord['reason'];

const ts = (minute: number): string => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

const SNAPSHOT = { systemPrompt: 'You are the agent.', tools: [{ name: 'read_file' }], templateId: 'system', templateHash: 'hash-1' };

/** Matches a raw Postgres error by SQLSTATE, optionally also by message. */
function pgError(code: string, message?: RegExp): (error: unknown) => boolean {
  return (error) => {
    const details = error as { code?: unknown; message?: unknown };
    return details.code === code && (message === undefined || message.test(String(details.message)));
  };
}

const UUID_SYNTAX = /invalid input syntax for type uuid/;

async function createTempDatabase(serverUrl: string): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `artemis_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: serverUrl });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const cleanup = new Pool({ connectionString: serverUrl });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

describe('PostgresStorage repositories against real Postgres', { skip }, () => {
  let database: { url: string; drop(): Promise<void> };
  let storage: PostgresStorage;
  let direct: Pool;

  const rowsOf = async (text: string, values: unknown[] = []): Promise<Array<Record<string, unknown>>> =>
    (await direct.query(text, values)).rows;
  const countRows = async (table: string, where: string, values: unknown[] = []): Promise<number> =>
    Number((await rowsOf(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, values))[0]?.n);

  const newConversation = async (title: string | null = null): Promise<string> => {
    const id = uuid();
    await storage.conversations.create({ id, title, titleSource: title === null ? null : 'user' }, SNAPSHOT);
    return id;
  };

  const turnInput = (conversationId: string, overrides: Partial<TurnInput> = {}): TurnInput => ({
    id: uuid(),
    conversationId,
    kind: 'user',
    modality: 'text',
    mode: 'text',
    effort: 'medium',
    status: 'running',
    clientMessageId: null,
    model: 'claude-haiku-5-5',
    startedAt: ts(1),
    ...overrides,
  });
  const newTurn = (conversationId: string): Promise<TurnRecord> => storage.turns.create(turnInput(conversationId));
  const completeTurn = async (conversationId: string): Promise<TurnRecord> => {
    const turn = await newTurn(conversationId);
    await storage.turns.finish(turn.id, { status: 'completed', error: null, usage: null, model: null, endedAt: ts(2) });
    return turn;
  };

  const newMessage = (
    conversationId: string,
    options: { role?: 'user' | 'assistant'; taskId?: string | null; turnId?: string | null } = {}
  ): Promise<MessageRecord> =>
    storage.messages.append({
      id: uuid(),
      conversationId,
      taskId: options.taskId ?? null,
      turnId: options.turnId ?? null,
      role: options.role ?? 'user',
      content: [{ type: 'text', text: 'hello' }],
      envelope: null,
      provider: null,
      model: null,
      providerMessageId: null,
      stopReason: null,
      usage: null,
      timings: null,
    });

  const newTask = (conversationId: string, overrides: Partial<TaskInput> = {}): Promise<TaskRecord> =>
    storage.tasks.create({
      id: prefixedId('task'),
      conversationId,
      kind: 'command',
      status: 'running',
      title: 'Build',
      prompt: null,
      subagentType: null,
      command: 'npm run build',
      cwd: '/workspace',
      outputPath: null,
      needsInput: false,
      originMode: 'text',
      originTurnId: null,
      originToolCallId: null,
      parentTaskId: null,
      resumedFromTaskId: null,
      depth: 0,
      model: null,
      startedAt: ts(1),
      ...overrides,
    });

  const newUpdate = (conversationId: string, taskId: string): Promise<BackgroundUpdateRecord> =>
    storage.updates.create({
      id: uuid(),
      conversationId,
      taskId,
      title: 'Build',
      status: 'completed',
      needsInput: false,
      report: 'Build passed.',
      durationMs: 1200,
      depth: 0,
      delivery: 'held',
      unread: true,
      createdAt: ts(2),
    });

  const startToolCall = (
    conversationId: string,
    assistantMessageId: string,
    turnId: string | null,
    taskId: string | null = null,
    id: string = prefixedId('call')
  ): Promise<void> => {
    const call: ToolCallInput = {
      id,
      conversationId,
      taskId,
      turnId,
      assistantMessageId,
      name: 'read_file',
      input: { path: 'a.txt' },
      startedAt: ts(2),
    };
    return storage.toolCalls.start(call);
  };

  const retainTurns = (
    conversationId: string,
    turnIds: string[],
    reason: RetentionReason = 'batch',
    operationId: string = uuid()
  ): Promise<MemoryRetentionRecord> =>
    storage.memoryRetentions.createForTurns({
      id: uuid(),
      conversationId,
      turnIds,
      documentId: `conversation:${conversationId}`,
      operationId,
      reason,
    });

  before(async () => {
    database = await createTempDatabase(baseUrl ?? '');
    storage = new PostgresStorage({ connectionString: database.url });
    await storage.migrate();
    direct = new Pool({ connectionString: database.url });
  });
  beforeEach(async () => {
    await direct.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);
  });
  after(async () => {
    await direct.end();
    await storage.close();
    await database.drop();
  });

  describe('persisted columns', () => {
    test('conversations persist title, title source, archive and MCP tool name columns, and the snapshot row', async () => {
      const id = uuid();
      await storage.conversations.create({ id, title: 'Hello', titleSource: 'user' }, { ...SNAPSHOT, systemPrompt: 'frozen' });
      await storage.conversations.setMcpToolNamesShown(id, ['mcp__docs__search']);

      const [conversation] = await rowsOf(
        'SELECT title, title_source, archived_at, mcp_tool_names_shown FROM conversations WHERE id = $1',
        [id]
      );
      assert.deepEqual(conversation, { title: 'Hello', title_source: 'user', archived_at: null, mcp_tool_names_shown: ['mcp__docs__search'] });

      await storage.conversations.archive(id);
      assert.notEqual((await rowsOf('SELECT archived_at FROM conversations WHERE id = $1', [id]))[0]?.archived_at, null);

      const [snapshot] = await rowsOf(
        'SELECT owner_kind, owner_id, system_prompt, tools, template_id, template_hash FROM prompt_snapshots WHERE owner_id = $1',
        [id]
      );
      assert.deepEqual(snapshot, {
        owner_kind: 'conversation',
        owner_id: id,
        system_prompt: 'frozen',
        tools: [{ name: 'read_file' }],
        template_id: 'system',
        template_hash: 'hash-1',
      });
    });

    test('turns persist kind, modality, mode, effort, seq and the finished status columns', async () => {
      const conversationId = await newConversation();
      const turn = await newTurn(conversationId);
      await storage.turns.finish(turn.id, {
        status: 'completed',
        error: null,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, steps: 1, lastContextTokens: 10 },
        model: 'claude-haiku-5-5',
        endedAt: ts(3),
      });

      const [row] = await rowsOf(
        'SELECT kind, modality, mode, effort, seq, status, model, usage IS NOT NULL AS has_usage, ended_at IS NOT NULL AS ended FROM turns WHERE id = $1',
        [turn.id]
      );
      assert.deepEqual(row, {
        kind: 'user',
        modality: 'text',
        mode: 'text',
        effort: 'medium',
        seq: 1,
        status: 'completed',
        model: 'claude-haiku-5-5',
        has_usage: true,
        ended: true,
      });
    });

    test('messages persist jsonb content and the nullable task and turn columns', async () => {
      const conversationId = await newConversation();
      const turn = await completeTurn(conversationId);
      const message = await newMessage(conversationId, { turnId: turn.id });

      const [row] = await rowsOf(
        'SELECT content, role, seq::int AS seq, task_id, turn_id::text AS turn_id FROM messages WHERE id = $1',
        [message.id]
      );
      assert.deepEqual(row, {
        content: [{ type: 'text', text: 'hello' }],
        role: 'user',
        seq: 1,
        task_id: null,
        turn_id: turn.id,
      });
    });

    test('tasks persist command, cwd, origin and depth columns', async () => {
      const conversationId = await newConversation();
      const turn = await completeTurn(conversationId);
      const task = await newTask(conversationId, { originTurnId: turn.id });

      const [row] = await rowsOf(
        `SELECT kind, status, command, cwd, origin_mode, origin_turn_id::text AS origin_turn_id, needs_input, depth, ended_at
         FROM tasks WHERE id = $1`,
        [task.id]
      );
      assert.deepEqual(row, {
        kind: 'command',
        status: 'running',
        command: 'npm run build',
        cwd: '/workspace',
        origin_mode: 'text',
        origin_turn_id: turn.id,
        needs_input: false,
        depth: 0,
        ended_at: null,
      });
    });

    test('tool_calls persist input jsonb, then the result columns when finished', async () => {
      const conversationId = await newConversation();
      const message = await newMessage(conversationId, { role: 'assistant' });
      const callId = prefixedId('call');
      await startToolCall(conversationId, message.id, null, null, callId);

      const [started] = await rowsOf('SELECT input, status, is_error, ended_at FROM tool_calls WHERE id = $1', [callId]);
      assert.deepEqual(started, { input: { path: 'a.txt' }, status: 'running', is_error: false, ended_at: null });

      await storage.toolCalls.finish(callId, { status: 'failed', resultText: 'boom', isError: true, display: null, taskRef: null, endedAt: ts(3) });
      const [finished] = await rowsOf('SELECT status, result_text, is_error, display, task_ref, ended_at IS NOT NULL AS ended FROM tool_calls WHERE id = $1', [callId]);
      assert.deepEqual(finished, { status: 'failed', result_text: 'boom', is_error: true, display: null, task_ref: null, ended: true });
    });

    test('background_updates persist delivery columns through claim and completion', async () => {
      const conversationId = await newConversation();
      const turn = await completeTurn(conversationId);
      const task = await newTask(conversationId);
      const update = await newUpdate(conversationId, task.id);

      const [held] = await rowsOf('SELECT delivery, unread, report, duration_ms, delivery_token, delivery_from FROM background_updates WHERE id = $1', [update.id]);
      assert.deepEqual(held, { delivery: 'held', unread: true, report: 'Build passed.', duration_ms: 1200, delivery_token: null, delivery_from: null });

      await storage.updates.claimHeld(conversationId, 'tok-1');
      const [inflight] = await rowsOf('SELECT delivery, delivery_token, delivery_from FROM background_updates WHERE id = $1', [update.id]);
      assert.deepEqual(inflight, { delivery: 'inflight', delivery_token: 'tok-1', delivery_from: 'held' });

      await storage.updates.complete('tok-1', turn.id, ts(4));
      const [delivered] = await rowsOf(
        'SELECT delivery, delivery_token, delivery_from, delivered_turn_id::text AS delivered_turn_id, delivered_at IS NOT NULL AS at FROM background_updates WHERE id = $1',
        [update.id]
      );
      assert.deepEqual(delivered, { delivery: 'delivered', delivery_token: null, delivery_from: null, delivered_turn_id: turn.id, at: true });
    });

    test('memory_retentions persist the uuid[] turn ids, document and operation ids, and mark their turns', async () => {
      const conversationId = await newConversation();
      const first = await completeTurn(conversationId);
      const second = await completeTurn(conversationId);
      const operationId = uuid();
      const retention = await retainTurns(conversationId, [first.id, second.id], 'flush', operationId);

      const [row] = await rowsOf(
        'SELECT turn_ids::text[] AS turn_ids, document_id, operation_id::text AS operation_id, reason, status, attempts FROM memory_retentions WHERE id = $1',
        [retention.id]
      );
      assert.deepEqual(row, {
        turn_ids: [first.id, second.id],
        document_id: `conversation:${conversationId}`,
        operation_id: operationId,
        reason: 'flush',
        status: 'pending',
        attempts: 0,
      });
      assert.equal(await countRows('turns', 'memory_retention_id = $1', [retention.id]), 2);
    });

    test('conversation_recalls persist one row per conversation and memory id', async () => {
      const conversationId = await newConversation();
      const turn = await completeTurn(conversationId);
      await storage.recallLedger.record(conversationId, turn.id, ['mem_a', 'mem_b']);

      const rows = await rowsOf('SELECT memory_id, turn_id::text AS turn_id FROM conversation_recalls WHERE conversation_id = $1 ORDER BY memory_id', [
        conversationId,
      ]);
      assert.deepEqual(rows, [
        { memory_id: 'mem_a', turn_id: turn.id },
        { memory_id: 'mem_b', turn_id: turn.id },
      ]);
    });
  });

  describe('uuid and text columns', () => {
    test('uuid() ids flow through every uuid column of one conversation', async () => {
      const conversationId = await newConversation('uuid chain');
      const turn = await newTurn(conversationId);
      const message = await newMessage(conversationId, { role: 'assistant', turnId: turn.id });
      await startToolCall(conversationId, message.id, turn.id);
      const task = await newTask(conversationId, { originTurnId: turn.id });
      await newUpdate(conversationId, task.id);
      const retention = await retainTurns(conversationId, [turn.id]);
      await storage.recallLedger.record(conversationId, turn.id, ['mem_1']);

      assert.equal((await storage.turns.get(turn.id))?.memoryRetentionId, retention.id);
      assert.equal((await storage.toolCalls.listForMessages([message.id])).length, 1);
      assert.equal((await storage.tasks.get(task.id))?.originTurnId, turn.id);
      assert.deepEqual([...(await storage.recallLedger.injectedIds(conversationId))], ['mem_1']);
    });

    test('conversations.create rejects a prefixed id and writes neither the row nor its snapshot', async () => {
      await assert.rejects(
        storage.conversations.create({ id: prefixedId('conv'), title: null, titleSource: null }, SNAPSHOT),
        pgError('22P02', UUID_SYNTAX)
      );
      assert.equal(await countRows('conversations', 'true'), 0);
      assert.equal(await countRows('prompt_snapshots', 'true'), 0);
    });

    test('every uuid column rejects a turn_ prefixed id with a Postgres uuid syntax error', async () => {
      const conversationId = await newConversation();
      const task = await newTask(conversationId);
      const bad = prefixedId('turn');
      const cases: Array<[string, () => Promise<unknown>]> = [
        ['turns.id', () => storage.turns.create(turnInput(conversationId, { id: bad }))],
        ['turns.conversation_id', () => storage.turns.create(turnInput(bad))],
        ['messages.conversation_id', () => newMessage(bad)],
        ['messages.turn_id', () => newMessage(conversationId, { turnId: bad })],
        ['tasks.origin_turn_id', () => newTask(conversationId, { originTurnId: bad })],
        ['tool_calls.assistant_message_id', () => startToolCall(conversationId, bad, null)],
        ['background_updates.conversation_id', () => newUpdate(bad, task.id)],
        ['memory_retentions.turn_ids', () => retainTurns(conversationId, [bad])],
        ['conversation_recalls.turn_id', () => storage.recallLedger.record(conversationId, bad, ['mem_1'])],
      ];
      // Plain loop, not t.test(): the per-test beforeEach truncation would run between subtests and drop the rows above.
      for (const [column, attempt] of cases) {
        await assert.rejects(attempt(), pgError('22P02', UUID_SYNTAX), `${column} should reject a non-uuid id`);
      }
    });

    test('reads with a non-uuid id fail with a Postgres error instead of returning null', async () => {
      await assert.rejects(storage.conversations.get('conv_abc'), pgError('22P02', UUID_SYNTAX));
      await assert.rejects(storage.turns.get('turn_abc'), pgError('22P02', UUID_SYNTAX));
      await assert.rejects(storage.messages.get('msg_abc'), pgError('22P02', UUID_SYNTAX));
    });

    test('text columns accept prefixed task, tool call, memory and snapshot ids', async () => {
      const conversationId = await newConversation();
      const turn = await completeTurn(conversationId);
      const parent = await newTask(conversationId);
      const child = await newTask(conversationId, { parentTaskId: parent.id, resumedFromTaskId: parent.id });
      assert.equal(child.parentTaskId, parent.id);
      assert.equal(child.resumedFromTaskId, parent.id);

      const message = await newMessage(conversationId, { role: 'assistant', taskId: child.id });
      const callId = prefixedId('call');
      await startToolCall(conversationId, message.id, null, child.id, callId);
      assert.equal((await storage.toolCalls.listForMessages([message.id]))[0]?.id, callId);

      const memoryId = prefixedId('mem');
      await storage.recallLedger.record(conversationId, turn.id, [memoryId]);
      assert.equal((await storage.recallLedger.injectedIds(conversationId)).has(memoryId), true);

      await storage.promptSnapshots.create({ ownerKind: 'task', ownerId: child.id, ...SNAPSHOT });
      assert.equal((await storage.promptSnapshots.getForOwner('task', child.id))?.ownerId, child.id);
    });
  });

  describe('foreign keys', () => {
    test('deleting a conversation cascades to all of its rows and leaves other conversations alone', async () => {
      const doomed = await newConversation();
      const keep = await newConversation();
      const turn = await completeTurn(doomed);
      const task = await newTask(doomed);
      const message = await newMessage(doomed, { role: 'assistant', turnId: turn.id });
      await newMessage(doomed, { taskId: task.id });
      await startToolCall(doomed, message.id, turn.id);
      await newUpdate(doomed, task.id);
      await retainTurns(doomed, [turn.id]);
      await storage.recallLedger.record(doomed, turn.id, ['mem_1']);
      const kept = await completeTurn(keep);

      await direct.query('DELETE FROM conversations WHERE id = $1', [doomed]);

      for (const table of ['turns', 'tasks', 'messages', 'tool_calls', 'background_updates', 'memory_retentions', 'conversation_recalls']) {
        assert.equal(await countRows(table, 'conversation_id = $1', [doomed]), 0, `${table} should cascade`);
      }
      assert.notEqual(await storage.turns.get(kept.id), null);
      assert.notEqual(await storage.conversations.get(keep), null);
    });

    test('deleting a turn keeps its rows and sets their turn reference to NULL', async () => {
      const conversationId = await newConversation();
      const turn = await newTurn(conversationId);
      const message = await newMessage(conversationId, { role: 'assistant', turnId: turn.id });
      const callId = prefixedId('call');
      await startToolCall(conversationId, message.id, turn.id, null, callId);
      const task = await newTask(conversationId, { originTurnId: turn.id });
      const update = await newUpdate(conversationId, task.id);
      await storage.updates.claimHeld(conversationId, 'tok-1');
      await storage.updates.complete('tok-1', turn.id, ts(3));
      await storage.recallLedger.record(conversationId, turn.id, ['mem_1']);

      await direct.query('DELETE FROM turns WHERE id = $1', [turn.id]);

      assert.equal((await storage.messages.get(message.id))?.turnId, null);
      assert.equal((await storage.toolCalls.listForMessages([message.id]))[0]?.turnId, null);
      assert.equal((await storage.tasks.get(task.id))?.originTurnId, null);
      assert.equal((await storage.updates.get(update.id))?.deliveredTurnId, null);
      assert.deepEqual(await rowsOf('SELECT turn_id FROM conversation_recalls WHERE conversation_id = $1', [conversationId]), [{ turn_id: null }]);
    });

    test('deleting a task removes its transcript, tool calls and update, and detaches child tasks', async () => {
      const conversationId = await newConversation();
      const parent = await newTask(conversationId);
      const child = await newTask(conversationId, { parentTaskId: parent.id, resumedFromTaskId: parent.id });
      const parentMessage = await newMessage(conversationId, { role: 'assistant', taskId: parent.id });
      await startToolCall(conversationId, parentMessage.id, null, parent.id);
      const update = await newUpdate(conversationId, parent.id);
      const childMessage = await newMessage(conversationId, { taskId: child.id });

      await direct.query('DELETE FROM tasks WHERE id = $1', [parent.id]);

      assert.equal(await storage.messages.get(parentMessage.id), null);
      assert.equal(await countRows('tool_calls', 'task_id = $1', [parent.id]), 0);
      assert.equal(await storage.updates.get(update.id), null);
      const detached = await storage.tasks.get(child.id);
      assert.equal(detached?.parentTaskId, null);
      assert.equal(detached?.resumedFromTaskId, null);
      assert.notEqual(await storage.messages.get(childMessage.id), null);
    });

    test('deleting an assistant message removes the tool calls it issued but keeps its turn', async () => {
      const conversationId = await newConversation();
      const turn = await newTurn(conversationId);
      const message = await newMessage(conversationId, { role: 'assistant', turnId: turn.id });
      await startToolCall(conversationId, message.id, turn.id);
      await startToolCall(conversationId, message.id, turn.id);

      await direct.query('DELETE FROM messages WHERE id = $1', [message.id]);

      assert.equal(await countRows('tool_calls', 'assistant_message_id = $1', [message.id]), 0);
      assert.notEqual(await storage.turns.get(turn.id), null);
    });

    test('deleting a memory retention makes its turns analysable again', async () => {
      const conversationId = await newConversation();
      const turn = await completeTurn(conversationId);
      const retention = await retainTurns(conversationId, [turn.id]);
      assert.equal((await storage.turns.get(turn.id))?.memoryRetentionId, retention.id);

      await direct.query('DELETE FROM memory_retentions WHERE id = $1', [retention.id]);

      assert.equal((await storage.turns.get(turn.id))?.memoryRetentionId, null);
      assert.deepEqual((await storage.turns.listUnanalyzed(conversationId)).map((row) => row.id), [turn.id]);
    });

    test('a missing parent surfaces as NotFoundError rather than a raw foreign-key error', async () => {
      const conversationId = await newConversation();
      await assert.rejects(newMessage(conversationId, { taskId: prefixedId('task') }), NotFoundError);
      await assert.rejects(startToolCall(conversationId, uuid(), null), NotFoundError);
      await assert.rejects(newUpdate(conversationId, prefixedId('task')), NotFoundError);
    });
  });

  describe('unique and check constraints', () => {
    test('memory retention operation_id is unique; a duplicate conflicts and leaves the second turn unlinked', async () => {
      const conversationId = await newConversation();
      const first = await completeTurn(conversationId);
      const second = await completeTurn(conversationId);
      const operationId = uuid();
      const retention = await retainTurns(conversationId, [first.id], 'batch', operationId);

      await assert.rejects(retainTurns(conversationId, [second.id], 'flush', operationId), ConflictError);
      assert.equal((await storage.turns.get(second.id))?.memoryRetentionId, null);
      assert.equal((await storage.turns.get(first.id))?.memoryRetentionId, retention.id);
    });

    test('turn seq is unique per conversation at the database level but may repeat across conversations', async () => {
      const conversationId = await newConversation();
      const otherId = await newConversation();
      await newTurn(conversationId);

      const insert = (id: string, conversation: string) =>
        direct.query(
          `INSERT INTO turns (id, conversation_id, seq, kind, modality, mode, status) VALUES ($1, $2, 1, 'user', 'text', 'text', 'running')`,
          [id, conversation]
        );
      await assert.rejects(insert(uuid(), conversationId), pgError('23505'));
      await insert(uuid(), otherId);
    });

    test('message seq is unique within a transcript but may repeat in a task transcript', async () => {
      const conversationId = await newConversation();
      const task = await newTask(conversationId);
      await newMessage(conversationId);

      const insert = (taskId: string | null) =>
        direct.query(
          `INSERT INTO messages (id, conversation_id, task_id, seq, role, content) VALUES ($1, $2, $3, 1, 'user', '[]'::jsonb)`,
          [uuid(), conversationId, taskId]
        );
      await assert.rejects(insert(null), pgError('23505'));
      await insert(task.id);
    });

    test('a conversation owner has exactly one prompt snapshot', async () => {
      const conversationId = await newConversation();
      await assert.rejects(
        storage.promptSnapshots.create({ ownerKind: 'conversation', ownerId: conversationId, ...SNAPSHOT }),
        ConflictError
      );
    });

    test('a task owner has exactly one prompt snapshot', async () => {
      const conversationId = await newConversation();
      const task = await newTask(conversationId);
      await storage.promptSnapshots.create({ ownerKind: 'task', ownerId: task.id, ...SNAPSHOT });
      await assert.rejects(storage.promptSnapshots.create({ ownerKind: 'task', ownerId: task.id, ...SNAPSHOT }), ConflictError);
    });

    test('a recall is recorded once per conversation, and the same memory may appear in two conversations', async () => {
      const a = await newConversation();
      const b = await newConversation();
      const turnA = await completeTurn(a);
      const turnB = await completeTurn(b);

      await storage.recallLedger.record(a, turnA.id, ['mem_1', 'mem_1']);
      await storage.recallLedger.record(b, turnB.id, ['mem_1']);

      assert.deepEqual([...(await storage.recallLedger.injectedIds(a))], ['mem_1']);
      assert.deepEqual([...(await storage.recallLedger.injectedIds(b))], ['mem_1']);
    });

    test('turns.status rejects a value outside its allowed set', async () => {
      const conversationId = await newConversation();
      const turn = await newTurn(conversationId);
      await assert.rejects(
        storage.turns.finish(turn.id, { status: 'done' as TurnRecord['status'], error: null, usage: null, model: null, endedAt: ts(2) }),
        pgError('23514')
      );
    });

    test('memory_retentions.reason rejects a value outside its allowed set', async () => {
      const conversationId = await newConversation();
      await assert.rejects(retainTurns(conversationId, [], 'nope' as RetentionReason), pgError('23514'));
    });

    test('conversations.title_source rejects a value outside its allowed set', async () => {
      const conversationId = await newConversation();
      await assert.rejects(storage.conversations.rename(conversationId, 'x', 'bogus' as 'user'), pgError('23514'));
    });

    test('mcp_settings only accepts the single row with id = 1', async () => {
      await assert.rejects(
        direct.query(`INSERT INTO mcp_settings (id, servers, revision) VALUES (2, '[]'::jsonb, 'r1')`),
        pgError('23514')
      );
    });
  });

  describe('transactions', () => {
    test('a database error inside a transaction rolls back the writes made before it', async () => {
      const id = uuid();
      await assert.rejects(
        storage.transaction(async (tx) => {
          await tx.conversations.create({ id, title: 'partial', titleSource: 'user' }, SNAPSHOT);
          await tx.turns.create(turnInput('not-a-uuid'));
        }),
        pgError('22P02', UUID_SYNTAX)
      );
      assert.equal(await countRows('conversations', 'id = $1', [id]), 0);
      assert.equal(await countRows('prompt_snapshots', 'owner_id = $1', [id]), 0);

      // The pool is still usable after the aborted transaction.
      await newConversation('after rollback');
    });

    test('failed transactions return their connections to the pool', { timeout: 20_000 }, async () => {
      // The default pool holds 10 connections; more failing transactions than that hang if any leak.
      for (let i = 0; i < 12; i += 1) {
        await assert.rejects(
          storage.transaction(async (tx) => {
            await tx.turns.create(turnInput('not-a-uuid'));
          }),
          pgError('22P02')
        );
      }
      await newConversation();
    });

    test('concurrent turn creation allocates unique, gap-free seq numbers', async () => {
      const conversationId = await newConversation();
      const turns = await Promise.all(Array.from({ length: 8 }, () => newTurn(conversationId)));
      assert.deepEqual(turns.map((turn) => turn.seq).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    });

    test('concurrent message appends allocate unique seq numbers within one transcript', async () => {
      const conversationId = await newConversation();
      const messages = await Promise.all(Array.from({ length: 8 }, () => newMessage(conversationId)));
      assert.deepEqual(messages.map((message) => message.seq).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    });
  });
});
