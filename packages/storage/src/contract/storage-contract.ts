/**
 * Behavioural contract every `Storage` implementation must pass. `InMemoryStorage` and `PostgresStorage` run
 * the same suite, so the fake stays a faithful stand-in for other packages' tests.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictError, NotFoundError, prefixedId, uuid } from '@artemis/core';
import type {
  BackgroundUpdateRecord,
  MessageRecord,
  PromptSnapshotRecord,
  TaskRecord,
  ToolCallRecord,
  TurnRecord,
} from '../domain.ts';
import type { Storage } from '../repositories.ts';

/** `fresh()` returns storage with no data (the same instance may be reset); `dispose()` releases it. */
export interface StorageFixture {
  fresh(): Promise<Storage>;
  dispose(): Promise<void>;
}

type SnapshotInput = Omit<PromptSnapshotRecord, 'id' | 'ownerKind' | 'ownerId' | 'createdAt'>;

const ts = (minute: number): string => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

const snapshot = (prompt = 'You are the agent.'): SnapshotInput => ({
  systemPrompt: prompt,
  tools: [{ name: 'read_file' }],
  templateId: 'system',
  templateHash: 'hash-1',
});

function turnInput(conversationId: string, startedAt = ts(1)): Omit<TurnRecord, 'seq' | 'endedAt' | 'memoryRetentionId' | 'usage' | 'recall' | 'error'> {
  return {
    id: uuid(),
    conversationId,
    kind: 'user',
    modality: 'text',
    mode: 'text',
    effort: 'medium',
    status: 'running',
    clientMessageId: null,
    model: 'claude-haiku-5-5',
    startedAt,
  };
}

function messageInput(
  conversationId: string,
  options: { role?: 'user' | 'assistant'; taskId?: string | null; turnId?: string | null; text?: string } = {}
): Omit<MessageRecord, 'seq' | 'createdAt' | 'deletedAt'> {
  return {
    id: uuid(),
    conversationId,
    taskId: options.taskId ?? null,
    turnId: options.turnId ?? null,
    role: options.role ?? 'user',
    content: [{ type: 'text', text: options.text ?? 'hello' }],
    envelope: null,
    provider: null,
    model: null,
    providerMessageId: null,
    stopReason: null,
    usage: null,
    timings: null,
  };
}

function taskInput(conversationId: string, startedAt = ts(1)): Omit<TaskRecord, 'endedAt' | 'stopRequestedAt' | 'exitCode' | 'stdoutTail' | 'stderrTail' | 'report' | 'usage'> {
  return {
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
    startedAt,
  };
}

function updateInput(
  conversationId: string,
  taskId: string,
  options: { delivery?: BackgroundUpdateRecord['delivery']; createdAt?: string } = {}
): Omit<BackgroundUpdateRecord, 'deliveryToken' | 'deliveryFrom' | 'deliveredTurnId' | 'deliveredAt' | 'readAt'> {
  return {
    id: uuid(),
    conversationId,
    taskId,
    title: 'Build',
    status: 'completed',
    needsInput: false,
    report: 'Build passed.',
    durationMs: 1200,
    depth: 0,
    delivery: options.delivery ?? 'held',
    unread: true,
    createdAt: options.createdAt ?? ts(2),
  };
}

async function newConversation(storage: Storage, title: string | null = null): Promise<string> {
  const id = uuid();
  await storage.conversations.create({ id, title, titleSource: title === null ? null : 'user' }, snapshot());
  return id;
}

async function newTurn(storage: Storage, conversationId: string, startedAt?: string): Promise<TurnRecord> {
  return storage.turns.create(turnInput(conversationId, startedAt));
}

async function newTask(storage: Storage, conversationId: string): Promise<TaskRecord> {
  return storage.tasks.create(taskInput(conversationId));
}

async function newAssistantMessage(storage: Storage, conversationId: string, turnId: string | null = null): Promise<MessageRecord> {
  return storage.messages.append(messageInput(conversationId, { role: 'assistant', turnId, text: 'calling tools' }));
}

export function storageContract(label: string, fixture: () => Promise<StorageFixture>): void {
  describe(`${label} storage contract`, () => {
    let harness: StorageFixture;
    let storage: Storage;

    before(async () => {
      harness = await fixture();
    });
    beforeEach(async () => {
      storage = await harness.fresh();
    });
    after(async () => {
      await harness.dispose();
    });

    describe('conversations and prompt snapshots', () => {
      test('create stores the conversation and its frozen snapshot', async () => {
        const id = uuid();
        const created = await storage.conversations.create({ id, title: null, titleSource: null }, snapshot('frozen'));

        assert.equal(created.id, id);
        assert.equal(created.title, null);
        assert.equal(created.archivedAt, null);
        assert.equal(created.mcpToolNamesShown, null);
        assert.equal(typeof created.createdAt, 'string');

        const stored = await storage.promptSnapshots.getForOwner('conversation', id);
        assert.equal(stored?.systemPrompt, 'frozen');
        assert.deepEqual(stored?.tools, [{ name: 'read_file' }]);
        assert.equal(stored?.templateHash, 'hash-1');
        assert.equal(await storage.promptSnapshots.getForOwner('task', id), null);
      });

      test('a second conversation with the same id or snapshot owner conflicts', async () => {
        const id = await newConversation(storage);
        await assert.rejects(
          storage.conversations.create({ id, title: null, titleSource: null }, snapshot()),
          ConflictError
        );
      });

      test('task snapshots are stored under their own owner', async () => {
        const conversationId = await newConversation(storage);
        const task = await newTask(storage, conversationId);
        const created = await storage.promptSnapshots.create({
          ownerKind: 'task',
          ownerId: task.id,
          ...snapshot('agent prompt'),
        });

        assert.equal(created.ownerKind, 'task');
        assert.equal((await storage.promptSnapshots.getForOwner('task', task.id))?.systemPrompt, 'agent prompt');
      });

      test('archive hides a conversation unless asked, and only archives once', async () => {
        const id = await newConversation(storage, 'Old');

        assert.equal(await storage.conversations.archive(id), true);
        assert.equal(await storage.conversations.archive(id), false);
        assert.equal(await storage.conversations.get(id), null);
        assert.equal((await storage.conversations.get(id, { includeArchived: true }))?.id, id);
        assert.deepEqual((await storage.conversations.list({ limit: 10 })).items, []);
      });

      test('list pages by most recent activity with a cursor', async () => {
        const first = await newConversation(storage, 'first');
        const second = await newConversation(storage, 'second');
        const third = await newConversation(storage, 'third');
        await storage.conversations.touch(first, ts(1));
        await storage.conversations.touch(third, ts(2));
        await storage.conversations.touch(second, ts(3));

        const page1 = await storage.conversations.list({ limit: 2 });
        assert.deepEqual(
          page1.items.map((row) => row.id),
          [second, third]
        );
        assert.equal(page1.nextCursor, third);

        const page2 = await storage.conversations.list({ limit: 2, after: page1.nextCursor ?? undefined });
        assert.deepEqual(page2.items.map((row) => row.id), [first]);
        assert.equal(page2.nextCursor, null);
      });

      test('auto titles only fill an untitled conversation; a user rename always wins', async () => {
        const id = await newConversation(storage);

        assert.equal(await storage.conversations.setTitleIfUntitled(id, 'Generated'), true);
        assert.equal(await storage.conversations.setTitleIfUntitled(id, 'Again'), false);
        assert.equal((await storage.conversations.get(id))?.titleSource, 'auto');

        const renamed = await storage.conversations.rename(id, 'Mine', 'user');
        assert.equal(renamed?.title, 'Mine');
        assert.equal(renamed?.titleSource, 'user');
        assert.equal(await storage.conversations.setTitleIfUntitled(id, 'Late'), false);
        assert.equal(await storage.conversations.rename(uuid(), 'Missing', 'user'), null);
      });

      test('touch and MCP tool names are persisted; unknown conversations are not found', async () => {
        const id = await newConversation(storage);
        await storage.conversations.touch(id, ts(5));
        await storage.conversations.setMcpToolNamesShown(id, ['mcp__docs__search']);

        const row = await storage.conversations.get(id);
        assert.equal(row?.lastMessageAt, ts(5));
        assert.deepEqual(row?.mcpToolNamesShown, ['mcp__docs__search']);

        await assert.rejects(storage.conversations.touch(uuid(), ts(6)), NotFoundError);
        await assert.rejects(storage.conversations.setMcpToolNamesShown(uuid(), []), NotFoundError);
      });
    });

    describe('turns and memory retention', () => {
      test('turn seq is allocated per conversation', async () => {
        const a = await newConversation(storage);
        const b = await newConversation(storage);

        assert.equal((await newTurn(storage, a)).seq, 1);
        assert.equal((await newTurn(storage, a)).seq, 2);
        assert.equal((await newTurn(storage, b)).seq, 1);
      });

      test('finish, setRecall and listUnanalyzed only return completed turns', async () => {
        const conversationId = await newConversation(storage);
        const done = await newTurn(storage, conversationId);
        const running = await newTurn(storage, conversationId);
        const usage = {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          steps: 1,
          lastContextTokens: 10,
        };

        await storage.turns.finish(done.id, { status: 'completed', error: null, usage, model: 'claude-haiku-5-5', endedAt: ts(3) });
        await storage.turns.setRecall(done.id, { budget: 'mid', query: 'q', memoryIds: ['m1'], durationMs: 4 });

        const stored = await storage.turns.get(done.id);
        assert.equal(stored?.status, 'completed');
        assert.deepEqual(stored?.usage, usage);
        assert.equal(stored?.recall?.memoryIds[0], 'm1');

        assert.deepEqual((await storage.turns.listUnanalyzed(conversationId)).map((row) => row.id), [done.id]);
        assert.equal((await storage.turns.latestWithUsage(conversationId))?.id, done.id);
        assert.equal(running.status, 'running');
      });

      test('createForTurns creates a pending retention and marks its turns analyzed', async () => {
        const conversationId = await newConversation(storage);
        const turn = await newTurn(storage, conversationId);
        await storage.turns.finish(turn.id, { status: 'completed', error: null, usage: null, model: null, endedAt: ts(2) });

        const retentionId = uuid();
        const retention = await storage.memoryRetentions.createForTurns({
          id: retentionId,
          conversationId,
          turnIds: [turn.id],
          documentId: `conversation:${conversationId}`,
          operationId: uuid(),
          reason: 'batch',
        });
        assert.equal(retention.status, 'pending');
        assert.equal(retention.attempts, 0);

        assert.deepEqual(await storage.turns.listUnanalyzed(conversationId), []);
        assert.equal((await storage.turns.get(turn.id))?.memoryRetentionId, retentionId);
        assert.deepEqual((await storage.memoryRetentions.listPending(10)).map((row) => row.id), [retentionId]);
      });

      test('failed attempts stay pending until terminal; submitted ones leave the outbox', async () => {
        const conversationId = await newConversation(storage);
        const turn = await newTurn(storage, conversationId);
        await storage.turns.finish(turn.id, { status: 'completed', error: null, usage: null, model: null, endedAt: ts(2) });
        const { id } = await storage.memoryRetentions.createForTurns({
          id: uuid(),
          conversationId,
          turnIds: [turn.id],
          documentId: 'doc',
          operationId: uuid(),
          reason: 'flush',
        });

        await storage.memoryRetentions.markAttemptFailed(id, 'timeout', false);
        assert.equal((await storage.memoryRetentions.listPending(10))[0]?.attempts, 1);

        await storage.memoryRetentions.markAttemptFailed(id, 'rejected', true);
        assert.deepEqual(await storage.memoryRetentions.listPending(10), []);

        const second = await storage.memoryRetentions.createForTurns({
          id: uuid(),
          conversationId,
          turnIds: [],
          documentId: 'doc',
          operationId: uuid(),
          reason: 'batch',
        });
        await storage.memoryRetentions.markSubmitted(second.id, ts(4));
        assert.deepEqual(await storage.memoryRetentions.listPending(10), []);
      });

      test('failRunning fails running turns and reports their ids', async () => {
        const conversationId = await newConversation(storage);
        const running = await newTurn(storage, conversationId);

        assert.deepEqual(await storage.turns.failRunning('interrupted by restart'), [running.id]);
        const stored = await storage.turns.get(running.id);
        assert.equal(stored?.status, 'failed');
        assert.equal(stored?.error, 'interrupted by restart');
        assert.deepEqual(await storage.turns.failRunning('again'), []);
      });
    });

    describe('messages and tool calls', () => {
      test('message seq is allocated per transcript and task transcripts are separate', async () => {
        const conversationId = await newConversation(storage);
        const task = await newTask(storage, conversationId);

        const first = await storage.messages.append(messageInput(conversationId, { text: 'one' }));
        const second = await storage.messages.append(messageInput(conversationId, { role: 'assistant', text: 'two' }));
        const inTask = await storage.messages.append(messageInput(conversationId, { taskId: task.id, text: 'task' }));

        assert.equal(first.seq, 1);
        assert.equal(second.seq, 2);
        assert.equal(inTask.seq, 1);
        assert.deepEqual(
          (await storage.messages.transcript(conversationId, null)).map((row) => row.content),
          [first.content, second.content]
        );
        assert.deepEqual((await storage.messages.transcript(conversationId, task.id)).map((row) => row.id), [inTask.id]);
      });

      test('page returns conversation messages newest first with a message cursor', async () => {
        const conversationId = await newConversation(storage);
        const task = await newTask(storage, conversationId);
        const ids: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          ids.push((await storage.messages.append(messageInput(conversationId, { text: `m${i}` }))).id);
        }
        await storage.messages.append(messageInput(conversationId, { taskId: task.id }));

        const page1 = await storage.messages.page(conversationId, { limit: 2 });
        assert.deepEqual(page1.items.map((row) => row.id), [ids[2], ids[1]]);
        assert.equal(page1.nextCursor, ids[1]);

        const page2 = await storage.messages.page(conversationId, { limit: 2, before: page1.nextCursor ?? undefined });
        assert.deepEqual(page2.items.map((row) => row.id), [ids[0]]);
        assert.equal(page2.nextCursor, null);
      });

      test('softDeleteFrom hides a message and everything after it; new messages continue the sequence', async () => {
        const conversationId = await newConversation(storage);
        const keep = await storage.messages.append(messageInput(conversationId, { text: 'keep' }));
        const target = await storage.messages.append(messageInput(conversationId, { text: 'target' }));
        const later = await storage.messages.append(messageInput(conversationId, { role: 'assistant', text: 'later' }));

        assert.equal(await storage.messages.softDeleteFrom(conversationId, target.id), 2);
        assert.deepEqual((await storage.messages.transcript(conversationId, null)).map((row) => row.id), [keep.id]);
        assert.equal((await storage.messages.page(conversationId, { limit: 10 })).items.length, 1);
        assert.notEqual((await storage.messages.get(later.id))?.deletedAt, null);

        const next = await storage.messages.append(messageInput(conversationId, { text: 'after rewind' }));
        assert.equal(next.seq, later.seq + 1);
      });

      test('tool calls start running and finish once, and cancelRunning cancels the rest', async () => {
        const conversationId = await newConversation(storage);
        const turn = await newTurn(storage, conversationId);
        const assistant = await newAssistantMessage(storage, conversationId, turn.id);
        const base = { conversationId, taskId: null, turnId: turn.id, assistantMessageId: assistant.id, input: { path: 'a.txt' }, startedAt: ts(2) };

        await storage.toolCalls.start({ ...base, id: 'toolu_1', name: 'read_file' });
        await storage.toolCalls.start({ ...base, id: 'toolu_2', name: 'bash', input: { command: 'sleep 1' } });
        await storage.toolCalls.finish('toolu_1', {
          status: 'completed',
          resultText: 'contents',
          isError: false,
          display: null,
          taskRef: null,
          endedAt: ts(3),
        });

        const calls = await storage.toolCalls.listForMessages([assistant.id]);
        const byId = new Map(calls.map((call: ToolCallRecord) => [call.id, call]));
        assert.equal(byId.get('toolu_1')?.status, 'completed');
        assert.equal(byId.get('toolu_1')?.resultText, 'contents');
        assert.equal(byId.get('toolu_2')?.status, 'running');

        assert.equal(await storage.toolCalls.cancelRunning('restart'), 1);
        const after = (await storage.toolCalls.listForMessages([assistant.id])).find((call) => call.id === 'toolu_2');
        assert.equal(after?.status, 'cancelled');
        assert.equal(after?.isError, true);
        assert.deepEqual(await storage.toolCalls.listForMessages([]), []);
      });
    });

    describe('tasks and background updates', () => {
      test('a task finishes exactly once and progress and stop requests are kept', async () => {
        const conversationId = await newConversation(storage);
        const task = await newTask(storage, conversationId);

        assert.deepEqual((await storage.tasks.listRunning(conversationId)).map((row) => row.id), [task.id]);
        await storage.tasks.updateProgress(task.id, { stdoutTail: 'building', outputPath: '/workspace/data/task.log' });
        await storage.tasks.requestStop(task.id, ts(4));
        await storage.tasks.requestStop(task.id, ts(5));

        const finished = await storage.tasks.finish(task.id, {
          status: 'completed',
          report: 'done',
          needsInput: false,
          exitCode: 0,
          stdoutTail: 'built',
          stderrTail: null,
          usage: null,
          endedAt: ts(6),
        });
        assert.equal(finished?.status, 'completed');
        assert.equal(finished?.stopRequestedAt, ts(4));
        assert.equal(finished?.outputPath, '/workspace/data/task.log');
        assert.equal(await storage.tasks.finish(task.id, { status: 'failed', report: 'late', needsInput: false, exitCode: 1, stdoutTail: null, stderrTail: null, usage: null, endedAt: ts(7) }), null);
        assert.deepEqual(await storage.tasks.listRunning(conversationId), []);
        assert.deepEqual((await storage.tasks.listByConversation(conversationId, { limit: 5 })).map((row) => row.id), [task.id]);
      });

      test('update delivery: held -> inflight -> delivered, and rollback returns to the origin state', async () => {
        const conversationId = await newConversation(storage);
        const turn = await newTurn(storage, conversationId);
        const first = await newTask(storage, conversationId);
        const second = await newTask(storage, conversationId);
        const a = await storage.updates.create(updateInput(conversationId, first.id, { createdAt: ts(2) }));
        const b = await storage.updates.create(updateInput(conversationId, second.id, { createdAt: ts(3) }));

        const claimed = await storage.updates.claimHeld(conversationId, 'token-1');
        assert.deepEqual(claimed.map((row) => row.id), [a.id, b.id]);
        assert.equal(claimed[0]?.delivery, 'inflight');
        assert.equal(await storage.updates.rollback('token-1'), 2);
        assert.equal((await storage.updates.get(a.id))?.delivery, 'held');

        assert.equal((await storage.updates.claimHeld(conversationId, 'token-2')).length, 2);
        assert.equal(await storage.updates.complete('token-2', turn.id, ts(9)), 2);
        const delivered = await storage.updates.get(a.id);
        assert.equal(delivered?.delivery, 'delivered');
        assert.equal(delivered?.deliveredTurnId, turn.id);
        assert.equal(delivered?.deliveryToken, null);
        assert.deepEqual(await storage.updates.listByConversation(conversationId, { delivery: ['held'] }), []);
        assert.equal(await storage.updates.revertInflight(), 0);
      });

      test('voice queue, unqueue, reads and unread counts', async () => {
        const conversationId = await newConversation(storage);
        const task = await newTask(storage, conversationId);
        const update = await storage.updates.create(updateInput(conversationId, task.id));

        assert.equal(await storage.updates.queue(update.id), true);
        assert.equal(await storage.updates.queue(update.id), false);
        assert.equal((await storage.updates.claimQueued(update.id, 'voice-1'))?.deliveryFrom, 'queued');
        assert.equal(await storage.updates.revertInflight(), 1);
        assert.equal(await storage.updates.unqueue(conversationId, [update.id]), 1);
        assert.equal((await storage.updates.get(update.id))?.delivery, 'held');

        assert.equal(await storage.updates.unreadCount(conversationId), 1);
        assert.equal(await storage.updates.markRead(conversationId, [update.id], ts(8)), 1);
        assert.equal(await storage.updates.unreadCount(conversationId), 0);
        assert.equal(await storage.updates.markRead(conversationId, [update.id], ts(9)), 0);
      });

      test('one update per task', async () => {
        const conversationId = await newConversation(storage);
        const task = await newTask(storage, conversationId);
        await storage.updates.create(updateInput(conversationId, task.id));
        await assert.rejects(storage.updates.create(updateInput(conversationId, task.id)), ConflictError);
      });
    });

    describe('settings, app state and recall ledger', () => {
      test('MCP settings save with compare-and-set on the revision', async () => {
        assert.equal(await storage.mcpSettings.get(), null);

        const first = await storage.mcpSettings.save({ servers: [], invalidEntries: [], revision: 'r1' }, null);
        assert.equal(first.revision, 'r1');
        await assert.rejects(storage.mcpSettings.save({ servers: [], invalidEntries: [], revision: 'r2' }, null), ConflictError);
        await assert.rejects(storage.mcpSettings.save({ servers: [], invalidEntries: [], revision: 'r2' }, 'stale'), ConflictError);

        const second = await storage.mcpSettings.save({ servers: [], invalidEntries: [{ bad: true }], revision: 'r2' }, 'r1');
        assert.equal(second.revision, 'r2');
        assert.deepEqual((await storage.mcpSettings.get())?.invalidEntries, [{ bad: true }]);
      });

      test('app state: set, get and swap return the previous value', async () => {
        assert.equal(await storage.appState.get('last_active_conversation_id'), null);
        await storage.appState.set('last_active_conversation_id', 'conv-1');
        assert.equal(await storage.appState.get('last_active_conversation_id'), 'conv-1');
        assert.equal(await storage.appState.swap('last_active_conversation_id', 'conv-2'), 'conv-1');
        assert.equal(await storage.appState.get('last_active_conversation_id'), 'conv-2');
      });

      test('recall ledger remembers injected memories per conversation', async () => {
        const conversationId = await newConversation(storage);
        const turn = await newTurn(storage, conversationId);

        await storage.recallLedger.record(conversationId, turn.id, ['m1', 'm2']);
        await storage.recallLedger.record(conversationId, turn.id, ['m2', 'm3']);

        assert.deepEqual([...(await storage.recallLedger.injectedIds(conversationId))].sort(), ['m1', 'm2', 'm3']);
        assert.deepEqual([...(await storage.recallLedger.injectedIds(uuid()))], []);
      });
    });

    describe('transactions and errors', () => {
      test('a committed transaction is visible afterwards', async () => {
        const id = uuid();
        await storage.transaction(async (tx) => {
          await tx.conversations.create({ id, title: 'in tx', titleSource: 'user' }, snapshot());
          await tx.turns.create(turnInput(id));
        });

        assert.equal((await storage.conversations.get(id))?.title, 'in tx');
        assert.equal((await storage.turns.listUnanalyzed(id)).length, 0);
        assert.equal((await storage.promptSnapshots.getForOwner('conversation', id))?.templateId, 'system');
      });

      test('a transaction that throws leaves no trace', async () => {
        const id = uuid();
        await assert.rejects(
          storage.transaction(async (tx) => {
            await tx.conversations.create({ id, title: 'doomed', titleSource: 'user' }, snapshot());
            throw new Error('boom');
          }),
          /boom/
        );

        assert.equal(await storage.conversations.get(id, { includeArchived: true }), null);
        assert.equal(await storage.promptSnapshots.getForOwner('conversation', id), null);
      });

      test('a transaction returns its callback value', async () => {
        const conversationId = await newConversation(storage);
        const seq = await storage.transaction(async (tx) => {
          const turn = await tx.turns.create(turnInput(conversationId));
          return turn.seq;
        });
        assert.equal(seq, 1);
      });

      test('missing parents and unknown rows are NotFound', async () => {
        await assert.rejects(newTurn(storage, uuid()), NotFoundError);
        await assert.rejects(storage.turns.finish(uuid(), { status: 'failed', error: 'x', usage: null, model: null, endedAt: ts(1) }), NotFoundError);
        await assert.rejects(storage.tasks.updateProgress(prefixedId('task'), { stdoutTail: 'x' }), NotFoundError);
        await assert.rejects(storage.memoryRetentions.markSubmitted(uuid(), ts(1)), NotFoundError);
      });
    });
  });
}

