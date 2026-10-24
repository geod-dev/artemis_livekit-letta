import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  toBackgroundUpdate,
  toConversation,
  toMcpSettings,
  toMemoryRetention,
  toMessage,
  toPromptSnapshot,
  toTask,
  toToolCall,
  toTurn,
  type BackgroundUpdateRow,
  type ConversationRow,
  type McpSettingsRow,
  type MemoryRetentionRow,
  type MessageRow,
  type PromptSnapshotRow,
  type TaskRow,
  type ToolCallRow,
  type TurnRow,
} from './mappers.ts';

// Row mappers run without a database: the rows below are what node-postgres returns
// (timestamptz as Date, bigint as string, jsonb already parsed).
const at = new Date('2026-01-02T03:04:05.000Z');
const iso = '2026-01-02T03:04:05.000Z';

const conversationRow: ConversationRow = {
  id: 'c1',
  title: 'Trip',
  title_source: 'auto',
  created_at: at,
  updated_at: at,
  last_message_at: null,
  archived_at: null,
  mcp_tool_names_shown: ['mcp__files__read'],
};

test('toConversation maps timestamps to ISO strings and keeps nulls', () => {
  assert.deepEqual(toConversation(conversationRow), {
    id: 'c1',
    title: 'Trip',
    titleSource: 'auto',
    createdAt: iso,
    updatedAt: iso,
    lastMessageAt: null,
    archivedAt: null,
    mcpToolNamesShown: ['mcp__files__read'],
  });
});

test('toConversation rejects a malformed timestamp instead of mapping it', () => {
  assert.throws(() => toConversation({ ...conversationRow, created_at: new Date('not a date') }), RangeError);
});

test('toPromptSnapshot maps the owner and template columns', () => {
  const row: PromptSnapshotRow = {
    id: 'p1',
    owner_kind: 'task',
    owner_id: 't1',
    conversation_id: 'c1',
    task_id: 't1',
    system_prompt: 'You are helpful.',
    tools: [{ name: 'bash' }],
    template_id: 'agent:research',
    template_hash: 'abc',
    created_at: at,
  };
  assert.deepEqual(toPromptSnapshot(row), {
    id: 'p1',
    ownerKind: 'task',
    ownerId: 't1',
    systemPrompt: 'You are helpful.',
    tools: [{ name: 'bash' }],
    templateId: 'agent:research',
    templateHash: 'abc',
    createdAt: iso,
  });
});

test('toTurn maps a finished turn and its usage', () => {
  const usage = {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 2,
    steps: 1,
    lastContextTokens: 10,
  };
  const row: TurnRow = {
    id: 'turn1',
    conversation_id: 'c1',
    seq: 1,
    kind: 'user',
    modality: 'text',
    mode: 'text',
    effort: 'high',
    status: 'completed',
    error: null,
    client_message_id: 'client-1',
    model: 'model-a',
    usage,
    recall: null,
    started_at: at,
    ended_at: at,
    memory_retention_id: null,
  };
  const record = toTurn(row);
  assert.equal(record.startedAt, iso);
  assert.equal(record.endedAt, iso);
  assert.equal(record.clientMessageId, 'client-1');
  assert.deepEqual(record.usage, usage);
  assert.equal(record.memoryRetentionId, null);
});

test('toMessage converts the bigint seq column to a number', () => {
  const row: MessageRow = {
    id: 'm1',
    conversation_id: 'c1',
    task_id: null,
    turn_id: 'turn1',
    seq: '7',
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    envelope: null,
    provider: 'anthropic',
    model: 'model-a',
    provider_message_id: 'msg_1',
    stop_reason: 'end_turn',
    usage: null,
    timings: null,
    created_at: at,
    deleted_at: null,
  };
  const record = toMessage(row);
  assert.equal(record.seq, 7);
  assert.equal(record.createdAt, iso);
  assert.equal(record.deletedAt, null);
  assert.deepEqual(record.content, [{ type: 'text', text: 'hi' }]);
});

test('toToolCall maps the call and its optional end time', () => {
  const row: ToolCallRow = {
    id: 'tool1',
    conversation_id: 'c1',
    task_id: null,
    turn_id: 'turn1',
    assistant_message_id: 'm1',
    name: 'bash',
    input: { command: 'ls' },
    status: 'completed',
    result_text: 'ok',
    is_error: false,
    display: null,
    task_ref: null,
    started_at: at,
    ended_at: at,
  };
  assert.deepEqual(toToolCall(row), {
    id: 'tool1',
    conversationId: 'c1',
    taskId: null,
    turnId: 'turn1',
    assistantMessageId: 'm1',
    name: 'bash',
    input: { command: 'ls' },
    status: 'completed',
    resultText: 'ok',
    isError: false,
    display: null,
    taskRef: null,
    startedAt: iso,
    endedAt: iso,
  });
});

test('toTask maps a running command task with no end time', () => {
  const row: TaskRow = {
    id: 'task1',
    conversation_id: 'c1',
    kind: 'command',
    status: 'running',
    title: 'Build',
    prompt: null,
    subagent_type: null,
    command: 'pnpm build',
    cwd: '/workspace',
    exit_code: null,
    stdout_tail: null,
    stderr_tail: null,
    output_path: null,
    report: null,
    needs_input: false,
    origin_mode: 'text',
    origin_turn_id: 'turn1',
    origin_tool_call_id: 'tool1',
    parent_task_id: null,
    resumed_from_task_id: null,
    depth: 0,
    model: null,
    usage: null,
    started_at: at,
    ended_at: null,
    stop_requested_at: null,
  };
  const record = toTask(row);
  assert.equal(record.kind, 'command');
  assert.equal(record.command, 'pnpm build');
  assert.equal(record.startedAt, iso);
  assert.equal(record.endedAt, null);
  assert.equal(record.stopRequestedAt, null);
});

test('toBackgroundUpdate maps the delivery columns and the read time', () => {
  const row: BackgroundUpdateRow = {
    id: 'u1',
    conversation_id: 'c1',
    task_id: 'task1',
    title: 'Build',
    status: 'completed',
    needs_input: false,
    report: 'done',
    duration_ms: null,
    depth: 0,
    delivery: 'delivered',
    delivery_token: null,
    delivery_from: 'queued',
    delivered_turn_id: 'turn2',
    unread: false,
    created_at: at,
    delivered_at: at,
    read_at: at,
  };
  const record = toBackgroundUpdate(row);
  assert.equal(record.durationMs, null);
  assert.equal(record.deliveryFrom, 'queued');
  assert.equal(record.createdAt, iso);
  assert.equal(record.deliveredAt, iso);
  assert.equal(record.readAt, iso);
});

test('toMcpSettings maps the singleton settings row', () => {
  const row: McpSettingsRow = {
    id: 1,
    servers: [],
    invalid_entries: [{ reason: 'bad' }],
    revision: 'r1',
    updated_at: at,
  };
  assert.deepEqual(toMcpSettings(row), {
    servers: [],
    invalidEntries: [{ reason: 'bad' }],
    revision: 'r1',
    updatedAt: iso,
  });
});

test('toMemoryRetention maps a pending retention without a submit time', () => {
  const row: MemoryRetentionRow = {
    id: 'mr1',
    conversation_id: 'c1',
    turn_ids: ['turn1'],
    document_id: 'conversation:c1',
    operation_id: 'op1',
    reason: 'batch',
    status: 'pending',
    attempts: 0,
    error: null,
    created_at: at,
    submitted_at: null,
  };
  assert.deepEqual(toMemoryRetention(row), {
    id: 'mr1',
    conversationId: 'c1',
    turnIds: ['turn1'],
    documentId: 'conversation:c1',
    operationId: 'op1',
    reason: 'batch',
    status: 'pending',
    attempts: 0,
    error: null,
    createdAt: iso,
    submittedAt: null,
  });
});
