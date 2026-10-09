/**
 * How turns are encoded into the canonical Letta conversation, and how stored
 * Letta messages are projected back into chat messages for the UI.
 *
 * Pure functions (no server imports) so they can be unit tested.
 */
import type { ChatAttachment, ChatMessage, Modality, TurnMode } from '../chat-types';

/**
 * Every turn starts with its interaction mode, e.g. `[voice-short] hello`. The
 * system prompt defines the modes. `[voice]` is the legacy voice prefix.
 */
const MODE_PREFIX = /^\[(text|voice-short|voice-long|voice)\](?: |\n|$)/;

/**
 * Voice turns also carry a reminder of the response's call state: fast models
 * follow a per-turn reminder far more reliably than the system prompt alone.
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

const STATE_MARKER = /\s*\[(listen|done)\]/gi;
const STATE_MARKERS = ['[listen]', '[done]'];

/** Removes state markers from streamed text and remembers the last one. */
export class CallStateFilter {
  private held = '';
  state: ResponseState | null = null;

  /** Text that can be spoken now; a possible marker start is held back. */
  push(chunk: string): string {
    let text = (this.held + chunk).replace(STATE_MARKER, (_, state: string) => {
      this.state = state.toLowerCase() as ResponseState;
      return '';
    });
    this.held = '';
    const open = text.lastIndexOf('[');
    if (open >= 0) {
      const tail = text.slice(open).toLowerCase();
      if (STATE_MARKERS.some((marker) => marker.startsWith(tail))) {
        // Hold the whitespace before it too: it goes with the marker.
        const start = text.slice(0, open).trimEnd().length;
        this.held = text.slice(start);
        text = text.slice(0, start);
      }
    }
    return text;
  }

  /** Text held back at the end of the response (not a marker after all). */
  flush(): string {
    const rest = this.held;
    this.held = '';
    return rest;
  }
}

/** Remove state markers from stored text. */
export function stripCallState(text: string): string {
  return text.replace(STATE_MARKER, '');
}

/** A finished background task, as delivered into the conversation. */
export interface BackgroundUpdate {
  id: string;
  title: string;
  status: 'completed' | 'failed' | 'cancelled';
  needsInput: boolean;
  report: string;
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
  currentDateTime?: string
): string {
  const reminder = mode === 'text' ? '' : VOICE_REMINDER;
  const datetime = currentDateTime
    ? `<current_datetime>${escapeAttr(currentDateTime)}</current_datetime>`
    : '';
  if (updates.length === 0 && attachments.length === 0 && !datetime) {
    return `${reminder}[${mode}] ${text}`;
  }
  const body = [
    `[${mode}]`,
    datetime,
    ...updates.map(encodeBackgroundUpdate),
    ...attachments.map(encodeAttachment),
    text,
  ].filter(Boolean);
  return reminder + body.join('\n');
}

type DecodedPart =
  | { kind: 'user'; text: string; modality: Modality; attachments?: ChatAttachment[] }
  | {
      kind: 'task_result';
      text: string;
      updateId?: string;
      status?: BackgroundUpdate['status'];
      detail?: string;
    }
  | { kind: 'memory'; text: string };

/** Split the text of a stored user-role message into what the UI shows. */
export function decodeUserContent(raw: string): DecodedPart[] {
  let text = stripSystemReminders(raw).trim();
  if (!text) return [];

  // Legacy delivery of the former custom delegation tool.
  const taskResult = text.match(/^<task-result\b[^>]*\btask="([^"]*)"[^>]*\bstatus="([^"]*)"/);
  if (taskResult) {
    const status = taskResult[2] === 'failed' ? 'failed' : 'finished';
    return [
      { kind: 'task_result', text: `Background task ${status}: ${unescapeAttr(taskResult[1])}` },
    ];
  }

  if (text.startsWith('<task-notification>')) {
    // Letta's own notifications: reflection (memory consolidation) completions,
    // or notifications that reached the conversation natively.
    const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? 'Task finished';
    const isMemory =
      /reflect|memory|dream/i.test(summary) || text.includes('<reflection-agent-id>');
    return isMemory
      ? [{ kind: 'memory', text: 'Memory updated' }]
      : [{ kind: 'task_result', text: summary }];
  }

  const mode = text.match(MODE_PREFIX);
  const modality: Modality = mode && mode[1] !== 'text' ? 'voice' : 'text';
  if (mode) text = text.slice(mode[0].length);
  // Current-time metadata is sent to Letta but is not part of the visible chat.
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
  if (status === 'failed') return `Background task failed: ${title}`;
  if (status === 'cancelled') return `Background task stopped: ${title}`;
  return `Background task finished: ${title}`;
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
        if (
          part &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .filter((t) => t && !/^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(t))
      .join('\n');
  }
  return '';
}

type LettaMessageLike = Record<string, unknown> & {
  id?: string;
  message_type?: string;
  date?: string;
  content?: unknown;
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
            row.result = ret.result;
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
    if (!c || typeof c !== 'object') return [];
    const call = c as Record<string, unknown>;
    const id = String(call.tool_call_id ?? call.id ?? '');
    const name = String(call.name ?? '');
    if (!id || !name) return [];
    return [{ id, name, args: typeof call.arguments === 'string' ? call.arguments : undefined }];
  });
}

function toolReturns(m: LettaMessageLike): { id: string; result: string; isError: boolean }[] {
  const raw = Array.isArray(m.tool_returns) ? m.tool_returns : [m];
  return raw.flatMap((r) => {
    if (!r || typeof r !== 'object') return [];
    const ret = r as Record<string, unknown>;
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
