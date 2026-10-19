/**
 * How turns are encoded into the canonical Letta conversation, and how stored
 * Letta messages are projected back into chat messages for the UI.
 *
 * Pure functions (no server imports) so they can be unit tested.
 */
import type { ChatAttachment, ChatMessage, Modality, TurnMode } from '../../chat-types';
import { extractTaskNotifications } from '../background/task-notifications.ts';

/**
 * Every turn starts with its interaction mode, e.g. `[voice-short] hello`. The
 * system prompt defines the modes. `[voice]` is the legacy voice prefix.
 */
const MODE_PREFIX = /^\[(text|voice-short|voice-long|voice)\](?: |\n|$)/;

/**
 * Voice turns also carry a reminder of the response's call state: the voice model
 * follows a per-turn reminder far more reliably than the system prompt alone.
 * Letta's system reminders are hidden in the chat.
 */
const VOICE_REMINDER =
  '<system-reminder>End your spoken response with [listen] if it asks the user anything or waits for their answer, otherwise with [done].</system-reminder>\n';

/**
 * Every voice response ends with its call state: `[listen]` when it waits for
 * the user's answer, `[done]` otherwise. The marker is the assistant's explicit
 * interaction state for the response; it is never spoken or shown.
 */
export type ResponseState = 'listen' | 'done';

const TRAILING_STATE_MARKER = /\s*\[(listen|done)\]\s*$/i;

/** Removes state markers from streamed text and remembers the last one. */
export class CallStateFilter {
  private held = '';
  state: ResponseState | null = null;

  /** Text that can be spoken now; a possible marker start is held back. */
  push(chunk: string): string {
    let text = this.held + chunk;
    this.held = '';
    const open = text.lastIndexOf('[');
    if (open >= 0) {
      const tail = text.slice(open).toLowerCase();
      const marker = ['[listen]', '[done]'].some((value) => value.startsWith(tail));
      if (marker && tail.length <= '[listen]'.length) {
        // Hold a possible trailing marker until the stream ends. If later text
        // follows, this was user-facing prose and is released unchanged.
        const start = text.slice(0, open).trimEnd().length;
        this.held = text.slice(start);
        text = text.slice(0, start);
      }
    }
    return text;
  }

  /** Text held back at the end of the response (not a marker after all). */
  flush(): string {
    const match = this.held.match(TRAILING_STATE_MARKER);
    if (match) this.state = match[1]!.toLowerCase() as ResponseState;
    const rest = match ? this.held.slice(0, match.index) : this.held;
    this.held = '';
    return rest;
  }
}

/** Remove only an explicit response-state marker at the very end of stored text. */
export function stripCallState(text: string): string {
  return text.replace(TRAILING_STATE_MARKER, '');
}

/** A finished background task, as delivered into the conversation. */
export interface BackgroundUpdate {
  id: string;
  taskId?: string;
  title: string;
  status: 'completed' | 'failed' | 'cancelled';
  needsInput: boolean;
  report: string;
  durationMs?: number;
}

const UPDATE_BLOCK = /<background-update\b([^>]*)>\n?([\s\S]*?)\n?<\/background-update>/g;

export function encodeBackgroundUpdate(u: BackgroundUpdate): string {
  const attrs =
    `id="${escapeAttr(u.id)}" task="${escapeAttr(u.title)}" status="${u.status}"` +
    (u.needsInput ? ' needs-input="true"' : '');
  const body = u.report.replaceAll('</background-update', '<\\/background-update');
  return `<background-update ${attrs}>\n${body}\n</background-update>`;
}

/**
 * Attachments precede the user's words as `<attachment>` tags (described in the
 * system prompt), with the file's path in the workspace.
 */
const LEADING_ATTACHMENTS = /^(?:<attachment\b[^>]*\/>\s*)+/;
const ATTACHMENT_TAG = /<attachment\b([^>]*)\/>/g;

export function encodeAttachment(a: ChatAttachment): string {
  const attrs = [
    `kind="${a.kind}"`,
    `path="${escapeAttr(a.path)}"`,
    `name="${escapeAttr(a.name)}"`,
    ...(a.mimeType ? [`mime_type="${escapeAttr(a.mimeType)}"`] : []),
    ...(a.size !== undefined ? [`size_bytes="${a.size}"`] : []),
  ];
  return `<attachment ${attrs.join(' ')} />`;
}

/**
 * Encode one turn: its mode, any background updates it delivers, the user's
 * attachments, then the user's words (absent for a turn that only delivers
 * updates).
 */
export function encodeTurn(
  mode: TurnMode,
  text: string,
  updates: readonly BackgroundUpdate[] = [],
  attachments: readonly ChatAttachment[] = [],
  currentDateTime?: string,
  clientMessageId?: string
): string {
  const reminder = mode === 'text' ? '' : VOICE_REMINDER;
  const datetime = currentDateTime
    ? `<current_datetime>${escapeAttr(currentDateTime)}</current_datetime>`
    : '';
  const body = [
    `[${mode}]`,
    datetime,
    ...updates.map(encodeBackgroundUpdate),
    ...attachments.map(encodeAttachment),
  ].filter(Boolean);
  const prompt = body.join('\n');
  const userSeparator = '\n<user-content>\n';
  const metadata = Buffer.from(
    JSON.stringify({ mode, currentDateTime, updates, attachments, clientMessageId, contentOffset: prompt.length + userSeparator.length }),
    'utf8'
  ).toString('base64url');
  const envelope = `[[app-envelope:v1:${metadata}]]`;
  return reminder + envelope + '\n' + prompt + userSeparator + text;
}

type DecodedPart =
  | {
      kind: 'user';
      text: string;
      modality: Modality;
      attachments?: ChatAttachment[];
      clientMessageId?: string;
    }
  | {
      kind: 'task_result';
      text: string;
      updateId?: string;
      taskId?: string;
      durationMs?: number;
      status?: BackgroundUpdate['status'];
      detail?: string;
    }
  | { kind: 'memory'; text: string };

/** Split the text of a stored user-role message into what the UI shows. */
export function decodeUserContent(raw: string): DecodedPart[] {
  const versionedSource = raw.startsWith(VOICE_REMINDER) ? raw.slice(VOICE_REMINDER.length) : raw;
  const v1 = versionedSource.match(/^\[\[app-envelope:v1:([A-Za-z0-9_-]+)\]\]\n/);
  // Versioned bodies are opaque user text after their delimiter. Only remove
  // the exact app reminder prefix; legacy messages retain the old reminder decoder.
  const stripped = v1 ? versionedSource : stripSystemReminders(raw);
  let text = stripped.trim();
  if (!text) return [];

  if (v1) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(v1[1]!, 'base64url').toString('utf8'));
      if (!isRecord(parsed)) throw new Error('invalid app envelope metadata');
      const metadata = parsed;
      const rendered = stripped.slice(v1[0].length);
      const contentOffset = metadata.contentOffset;
      const separator = '\n<user-content>\n';
      if (!Number.isSafeInteger(contentOffset) || (contentOffset as number) < separator.length ||
        rendered.slice((contentOffset as number) - separator.length, contentOffset as number) !== separator) return [];
      const body = rendered.slice(contentOffset as number);
      const modality: Modality = metadata.mode === 'text' ? 'text' : 'voice';
      const parts: DecodedPart[] = [];
      if (Array.isArray(metadata.updates)) {
        for (const item of metadata.updates) {
          if (!item || typeof item !== 'object') continue;
          const update = item as Partial<BackgroundUpdate>;
          if (typeof update.title !== 'string' || typeof update.report !== 'string') continue;
          const status = (['completed', 'failed', 'cancelled'] as const).find((s) => s === update.status);
          parts.push({
            kind: 'task_result',
            text: updateLabel(update.title, status, update.needsInput === true),
            ...(typeof update.id === 'string' ? { updateId: update.id } : {}),
            ...(typeof update.taskId === 'string' ? { taskId: update.taskId } : {}),
            ...(status ? { status } : {}),
            ...(typeof update.durationMs === 'number' && Number.isFinite(update.durationMs) && update.durationMs >= 0 ? { durationMs: update.durationMs } : {}),
            detail: update.report,
          });
        }
      }
      const attachments = Array.isArray(metadata.attachments)
        ? metadata.attachments.filter(isChatAttachment)
        : [];
      if (body.trim() || attachments.length) {
        parts.push({
          kind: 'user',
          text: body,
          modality,
          ...(attachments.length ? { attachments } : {}),
          ...(typeof metadata.clientMessageId === 'string'
            ? { clientMessageId: metadata.clientMessageId }
            : {}),
        });
      }
      return parts;
    } catch {
      // Invalid envelopes remain invisible to the legacy parser rather than
      // interpreting app-looking strings inside the user's words as metadata.
      return [{ kind: 'user', text, modality: 'text' }];
    }
  }

  // Legacy delivery of the former custom delegation tool.
  const taskResult = text.match(/^<task-result\b[^>]*\btask="([^"]*)"[^>]*\bstatus="([^"]*)"/);
  if (taskResult) {
    const status = taskResult[2] === 'failed' ? 'failed' : 'finished';
    return [
      { kind: 'task_result', text: `Background task ${status}: ${unescapeAttr(taskResult[1])}` },
    ];
  }

  if (text.startsWith('<task-notification>')) {
    const { notifications } = extractTaskNotifications(text);
    if (notifications.length) return notifications.map((notification) => ({
      kind: 'task_result',
      taskId: notification.taskId,
      status: notification.status,
      ...(notification.durationMs !== undefined ? { durationMs: notification.durationMs } : {}),
      text: updateLabel(
        notification.summary.replace(/^Agent "(.*)" (completed|failed)$/, '$1') || 'Background task',
        notification.status, notification.needsInput
      ),
      detail: notification.report,
    }));
    // Reflection notifications have no task id/status and remain memory notes.
    const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? 'Task finished';
    const isMemory =
      /reflect|memory|dream/i.test(summary) || text.includes('<reflection-agent-id>');
    return isMemory
      ? [{ kind: 'memory', text: 'Memory updated' }]
      : [];
  }

  const mode = text.match(MODE_PREFIX);
  const modality: Modality = mode && mode[1] !== 'text' ? 'voice' : 'text';
  if (mode) text = text.slice(mode[0].length);
  // Legacy current-time metadata is sent to Letta but is not visible in chat.
  text = text.replace(/^<current_datetime\b[^>]*>[\s\S]*?<\/current_datetime>\s*/, '');

  const parts: DecodedPart[] = [];
  text = text.replace(UPDATE_BLOCK, (_block, attrs: string, body: string) => {
    parts.push(decodeUpdate(attrs, body));
    return '';
  });
  const attachments: ChatAttachment[] = [];
  text = text
    .trim()
    .replace(LEADING_ATTACHMENTS, (block) => {
      for (const [, attrs] of block.matchAll(ATTACHMENT_TAG)) {
        const attachment = decodeAttachment(attrs);
        if (attachment) attachments.push(attachment);
      }
      return '';
    })
    .trim();
  if (text || attachments.length) {
    parts.push({ kind: 'user', text, modality, ...(attachments.length ? { attachments } : {}) });
  }
  return parts;
}

function isChatAttachment(value: unknown): value is ChatAttachment {
  if (!isRecord(value)) return false;
  const item = value;
  return typeof item.path === 'string' && typeof item.name === 'string' &&
    (item.kind === 'file' || item.kind === 'image') &&
    (item.mimeType === undefined || typeof item.mimeType === 'string') &&
    (item.size === undefined || (typeof item.size === 'number' && Number.isSafeInteger(item.size)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeAttachment(attrs: string): ChatAttachment | null {
  const attr = (name: string) => {
    const value = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    return value === undefined ? undefined : unescapeAttr(value);
  };
  // Earlier turns named the file by its id in the former attachments folder.
  const legacyId = attr('attachment_id');
  const path = attr('path') ?? (legacyId && `data/attachments/${legacyId}`);
  if (!path) return null;
  const mimeType = attr('mime_type');
  const size = attr('size_bytes');
  return {
    path,
    name: attr('name') ?? path.split('/').at(-1)!,
    kind: attr('kind') === 'image' ? 'image' : 'file',
    ...(mimeType ? { mimeType } : {}),
    ...(size ? { size: Number(size) } : {}),
  };
}

function decodeUpdate(attrs: string, body: string): DecodedPart {
  const attr = (name: string) => {
    const value = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    return value === undefined ? undefined : unescapeAttr(value);
  };
  const status = (['completed', 'failed', 'cancelled'] as const).find((s) => s === attr('status'));
  return {
    kind: 'task_result',
    text: updateLabel(attr('task') ?? 'Background task', status, attr('needs-input') === 'true'),
    updateId: attr('id'),
    status,
    detail: body.replaceAll('<\\/background-update', '</background-update').trim(),
  };
}

export function updateLabel(
  title: string,
  status: BackgroundUpdate['status'] | undefined,
  needsInput: boolean
): string {
  if (needsInput) return `Needs your input: ${title}`;
  if (status === 'failed') return `${title} - background task failed`;
  if (status === 'cancelled') return `${title} - background task stopped`;
  return `${title} - background task finished`;
}

export function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
}

/** Flatten Letta message content (string or content parts) to text. */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isRecord(part) && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter((t) => t && !/^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(t))
      .join('\n');
  }
  return '';
}

export type LettaMessageLike = {
  id?: string;
  message_type?: string;
  date?: string;
  content?: unknown;
  reasoning?: unknown;
  tool_call?: unknown;
  tool_calls?: unknown;
  tool_returns?: unknown;
  tool_call_id?: unknown;
  tool_return?: unknown;
  func_response?: unknown;
  status?: unknown;
};

/** Project stored Letta messages (oldest first) into UI chat messages. */
export function normalizeHistory(messages: readonly LettaMessageLike[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const tools = new Map<string, Extract<ChatMessage, { role: 'tool' }>>();

  for (const m of messages) {
    const id = String(m.id ?? `${out.length}`);
    const createdAt = typeof m.date === 'string' ? m.date : undefined;

    switch (m.message_type) {
      case 'user_message': {
        const parts = decodeUserContent(contentToText(m.content));
        parts.forEach((part, index) => {
          // The user's words keep the message id (deleting a message targets it).
          const rowId = part.kind === 'user' ? id : `${id}:${index}`;
          if (part.kind === 'user') {
            out.push({
              id: rowId,
              role: 'user',
              text: part.text,
              modality: part.modality,
              ...(part.clientMessageId ? { clientMessageId: part.clientMessageId } : {}),
              ...(part.attachments ? { attachments: part.attachments } : {}),
              createdAt,
            });
          } else if (part.kind === 'memory') {
            out.push({ id: rowId, role: 'event', kind: 'memory', text: part.text, createdAt });
          } else {
            out.push({
              id: rowId,
              role: 'event',
              kind: 'task_result',
              text: part.text,
              ...(part.updateId ? { updateId: part.updateId } : {}),
              ...(part.taskId ? { taskId: part.taskId } : {}),
              ...(part.status ? { status: part.status } : {}),
              ...(part.durationMs !== undefined ? { durationMs: part.durationMs } : {}),
              ...(part.detail ? { detail: part.detail } : {}),
              createdAt,
            });
          }
        });
        break;
      }
      case 'reasoning_message':
      case 'assistant_message': {
        const role = m.message_type === 'reasoning_message' ? 'reasoning' : 'assistant';
        const raw = contentToText(role === 'reasoning' ? m.reasoning : m.content);
        const text = (role === 'assistant' ? stripCallState(raw) : raw).trim();
        if (!text) break;
        // Consecutive assistant chunks of one step are stored as one row; merge by id.
        const rowId = role === 'reasoning' ? `${role}:${id}` : id;
        const prev = out.at(-1);
        if (prev && prev.role === role && prev.id === rowId) prev.text += text;
        else out.push({ id: rowId, role, text, createdAt });
        break;
      }
      case 'tool_call_message':
      // Client-tool calls are persisted as (auto-approved) approval requests.
      case 'approval_request_message': {
        for (const call of toolCalls(m)) {
          const row: Extract<ChatMessage, { role: 'tool' }> = {
            id: `${id}:${call.id}`,
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            args: call.args,
            createdAt,
          };
          tools.set(call.id, row);
          out.push(row);
        }
        break;
      }
      case 'tool_return_message': {
        for (const ret of toolReturns(m)) {
          const row = tools.get(ret.id);
          if (row) {
            row.result = ret.result.replace(/\[\[mcp-managed-artifacts:v1:[0-9a-f-]{36}\]\]/gi, '');
            row.isError = ret.isError;
          }
        }
        break;
      }
      default:
        break; // system, summaries, usage... are not shown
    }
  }
  return out;
}

function toolCalls(m: LettaMessageLike): { id: string; name: string; args?: string }[] {
  const raw = Array.isArray(m.tool_calls) ? m.tool_calls : m.tool_call ? [m.tool_call] : [];
  return raw.flatMap((c) => {
    if (!isRecord(c)) return [];
    const call = c;
    const id = String(call.tool_call_id ?? call.id ?? '');
    const name = String(call.name ?? '');
    if (!id || !name) return [];
    return [{ id, name, args: typeof call.arguments === 'string' ? call.arguments : undefined }];
  });
}

function toolReturns(m: LettaMessageLike): { id: string; result: string; isError: boolean }[] {
  const raw = Array.isArray(m.tool_returns) ? m.tool_returns : [m];
  return raw.flatMap((r) => {
    if (!isRecord(r)) return [];
    const ret = r;
    const id = String(ret.tool_call_id ?? '');
    if (!id) return [];
    const value = ret.tool_return ?? ret.func_response ?? '';
    return [
      {
        id,
        result: typeof value === 'string' ? value : JSON.stringify(value),
        isError: ret.status === 'error',
      },
    ];
  });
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeAttr(s: string): string {
  return s
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}
