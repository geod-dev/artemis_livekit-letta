/**
 * Row shapes of `migrations/*.sql` and their mapping to the domain records. `pg` returns timestamptz as Date,
 * bigint as string and jsonb already parsed; this module normalizes all of that.
 */
import type {
  BackgroundUpdateRecord,
  ConversationRecord,
  DeliveryState,
  JsonValue,
  McpSettingsRecord,
  MemoryRetentionRecord,
  MessageRecord,
  PromptSnapshotRecord,
  RecallTrace,
  StoredContent,
  TaskRecord,
  ToolCallRecord,
  TurnRecord,
  TurnUsage,
  UserTurnEnvelope,
} from '../domain.ts';
import type { McpServer, ToolDisplay, ToolTaskRef } from '@artemis/contracts/chat-types';

export interface ConversationRow {
  id: string;
  title: string | null;
  title_source: 'auto' | 'user' | null;
  created_at: Date;
  updated_at: Date;
  last_message_at: Date | null;
  archived_at: Date | null;
  mcp_tool_names_shown: string[] | null;
}

export interface PromptSnapshotRow {
  id: string;
  owner_kind: 'conversation' | 'task';
  owner_id: string;
  system_prompt: string;
  tools: JsonValue[];
  template_id: string;
  template_hash: string;
  created_at: Date;
}

export interface TurnRow {
  id: string;
  conversation_id: string;
  seq: number;
  kind: 'user' | 'update';
  modality: 'text' | 'voice';
  mode: 'text' | 'voice-short' | 'voice-long';
  effort: TurnRecord['effort'];
  status: TurnRecord['status'];
  error: string | null;
  client_message_id: string | null;
  model: string | null;
  usage: TurnUsage | null;
  recall: RecallTrace | null;
  started_at: Date;
  ended_at: Date | null;
  memory_retention_id: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  task_id: string | null;
  turn_id: string | null;
  seq: string;
  role: 'user' | 'assistant';
  content: StoredContent;
  envelope: UserTurnEnvelope | null;
  provider: string | null;
  model: string | null;
  provider_message_id: string | null;
  stop_reason: string | null;
  usage: JsonValue | null;
  timings: JsonValue | null;
  created_at: Date;
  deleted_at: Date | null;
}

export interface ToolCallRow {
  id: string;
  conversation_id: string;
  task_id: string | null;
  turn_id: string | null;
  assistant_message_id: string;
  name: string;
  input: JsonValue;
  status: ToolCallRecord['status'];
  result_text: string | null;
  is_error: boolean;
  display: ToolDisplay | null;
  task_ref: ToolTaskRef | null;
  started_at: Date;
  ended_at: Date | null;
}

export interface TaskRow {
  id: string;
  conversation_id: string;
  kind: TaskRecord['kind'];
  status: TaskRecord['status'];
  title: string;
  prompt: string | null;
  subagent_type: string | null;
  command: string | null;
  cwd: string | null;
  exit_code: number | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
  output_path: string | null;
  report: string | null;
  needs_input: boolean;
  origin_mode: TaskRecord['originMode'];
  origin_turn_id: string | null;
  origin_tool_call_id: string | null;
  parent_task_id: string | null;
  resumed_from_task_id: string | null;
  depth: number;
  model: string | null;
  usage: JsonValue | null;
  started_at: Date;
  ended_at: Date | null;
  stop_requested_at: Date | null;
}

export interface BackgroundUpdateRow {
  id: string;
  conversation_id: string;
  task_id: string;
  title: string;
  status: BackgroundUpdateRecord['status'];
  needs_input: boolean;
  report: string;
  duration_ms: number | null;
  depth: number;
  delivery: DeliveryState;
  delivery_token: string | null;
  delivery_from: 'held' | 'queued' | null;
  delivered_turn_id: string | null;
  unread: boolean;
  created_at: Date;
  delivered_at: Date | null;
  read_at: Date | null;
}

export interface McpSettingsRow {
  id: number;
  servers: McpServer[];
  invalid_entries: JsonValue[];
  revision: string;
  updated_at: Date;
}

export interface MemoryRetentionRow {
  id: string;
  conversation_id: string;
  turn_ids: string[];
  document_id: string;
  operation_id: string;
  reason: MemoryRetentionRecord['reason'];
  status: MemoryRetentionRecord['status'];
  attempts: number;
  error: string | null;
  created_at: Date;
  submitted_at: Date | null;
}

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value === null ? null : iso(value));

/** Value for a jsonb parameter. node-postgres would send arrays as SQL arrays, so JSON is always explicit. */
export function jsonParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function toConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    title: row.title,
    titleSource: row.title_source,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastMessageAt: isoOrNull(row.last_message_at),
    archivedAt: isoOrNull(row.archived_at),
    mcpToolNamesShown: row.mcp_tool_names_shown,
  };
}

export function toPromptSnapshot(row: PromptSnapshotRow): PromptSnapshotRecord {
  return {
    id: row.id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    systemPrompt: row.system_prompt,
    tools: row.tools,
    templateId: row.template_id,
    templateHash: row.template_hash,
    createdAt: iso(row.created_at),
  };
}

export function toTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    kind: row.kind,
    modality: row.modality,
    mode: row.mode,
    effort: row.effort,
    status: row.status,
    error: row.error,
    clientMessageId: row.client_message_id,
    model: row.model,
    usage: row.usage,
    recall: row.recall,
    startedAt: iso(row.started_at),
    endedAt: isoOrNull(row.ended_at),
    memoryRetentionId: row.memory_retention_id,
  };
}

export function toMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    turnId: row.turn_id,
    seq: Number(row.seq),
    role: row.role,
    content: row.content,
    envelope: row.envelope,
    provider: row.provider,
    model: row.model,
    providerMessageId: row.provider_message_id,
    stopReason: row.stop_reason,
    usage: row.usage,
    timings: row.timings,
    createdAt: iso(row.created_at),
    deletedAt: isoOrNull(row.deleted_at),
  };
}

export function toToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    turnId: row.turn_id,
    assistantMessageId: row.assistant_message_id,
    name: row.name,
    input: row.input,
    status: row.status,
    resultText: row.result_text,
    isError: row.is_error,
    display: row.display,
    taskRef: row.task_ref,
    startedAt: iso(row.started_at),
    endedAt: isoOrNull(row.ended_at),
  };
}

export function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    prompt: row.prompt,
    subagentType: row.subagent_type,
    command: row.command,
    cwd: row.cwd,
    exitCode: row.exit_code,
    stdoutTail: row.stdout_tail,
    stderrTail: row.stderr_tail,
    outputPath: row.output_path,
    report: row.report,
    needsInput: row.needs_input,
    originMode: row.origin_mode,
    originTurnId: row.origin_turn_id,
    originToolCallId: row.origin_tool_call_id,
    parentTaskId: row.parent_task_id,
    resumedFromTaskId: row.resumed_from_task_id,
    depth: row.depth,
    model: row.model,
    usage: row.usage,
    startedAt: iso(row.started_at),
    endedAt: isoOrNull(row.ended_at),
    stopRequestedAt: isoOrNull(row.stop_requested_at),
  };
}

export function toBackgroundUpdate(row: BackgroundUpdateRow): BackgroundUpdateRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    title: row.title,
    status: row.status,
    needsInput: row.needs_input,
    report: row.report,
    durationMs: row.duration_ms,
    depth: row.depth,
    delivery: row.delivery,
    deliveryToken: row.delivery_token,
    deliveryFrom: row.delivery_from,
    deliveredTurnId: row.delivered_turn_id,
    unread: row.unread,
    createdAt: iso(row.created_at),
    deliveredAt: isoOrNull(row.delivered_at),
    readAt: isoOrNull(row.read_at),
  };
}

export function toMcpSettings(row: McpSettingsRow): McpSettingsRecord {
  return {
    servers: row.servers,
    invalidEntries: row.invalid_entries,
    revision: row.revision,
    updatedAt: iso(row.updated_at),
  };
}

export function toMemoryRetention(row: MemoryRetentionRow): MemoryRetentionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnIds: row.turn_ids,
    documentId: row.document_id,
    operationId: row.operation_id,
    reason: row.reason,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    createdAt: iso(row.created_at),
    submittedAt: isoOrNull(row.submitted_at),
  };
}
