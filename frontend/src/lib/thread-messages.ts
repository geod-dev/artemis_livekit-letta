import type { ThreadMessageLike } from '@assistant-ui/react';
import type { ChatAttachment, ChatMessage } from '@backend/chat-types';
import { workspaceUrl } from './attachments.ts';

type AssistantPart = Extract<ThreadMessageLike['content'], readonly unknown[]>[number];

interface CachedMessage {
  inputs: readonly ChatMessage[];
  voice: boolean;
  stopped: boolean;
  output: ThreadMessageLike | ThreadMessageLike[];
}

const CANCELLED = { type: 'incomplete', reason: 'cancelled' } as const;

/** Converted messages keyed by their first source message id. */
export type ThreadMessageCache = Map<string, CachedMessage>;

/**
 * Convert the gateway's flat message list into assistant-ui thread messages.
 *
 * - Consecutive assistant text and tool rows become one assistant message, so a
 *   turn renders as a single response with its tool calls inline.
 * - Voice user messages carry `metadata.modality: "voice"`, and so do the
 *   replies that follow them, so the thread draws a call as one spoken block.
 * - Events (task results, memory updates) become system messages; their kind,
 *   background update id, full report and unread state are kept in
 *   `metadata.custom`.
 *
 * - `stopped` holds the last row of each turn the user stopped. The reply
 *   ending with it gets the `incomplete` / `cancelled` status; a stop that left
 *   no reply adds an empty cancelled reply after the user message.
 *
 * Pass the cache returned by the previous call to reuse unchanged messages:
 * assistant-ui only re-renders messages whose object identity changed.
 */
export function toThreadMessages(
  messages: readonly ChatMessage[],
  previous: ThreadMessageCache = new Map(),
  stopped: ReadonlySet<string> = new Set()
): { messages: ThreadMessageLike[]; cache: ThreadMessageCache } {
  const cache: ThreadMessageCache = new Map();
  const result: ThreadMessageLike[] = [];
  let voice = false;

  const emit = (
    inputs: readonly ChatMessage[],
    build: (isStopped: boolean) => ThreadMessageLike | ThreadMessageLike[]
  ) => {
    const key = inputs[0].id;
    const isStopped = stopped.has(inputs[inputs.length - 1].id);
    const hit = previous.get(key);
    const reuse =
      hit &&
      hit.voice === voice &&
      hit.stopped === isStopped &&
      hit.inputs.length === inputs.length &&
      hit.inputs.every((m, i) => m === inputs[i]);
    const entry = reuse ? hit : { inputs, voice, stopped: isStopped, output: build(isStopped) };
    cache.set(key, entry);
    result.push(...[entry.output].flat());
  };

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    switch (message.role) {
      case 'user':
        voice = message.modality === 'voice';
        emit([message], (isStopped) => {
          const metadata = voice ? ({ modality: 'voice' } as const) : undefined;
          const user: ThreadMessageLike = {
            id: message.id,
            role: 'user',
            content: message.text ? [{ type: 'text', text: message.text }] : [],
            attachments: message.attachments?.map(toThreadAttachment),
            createdAt: toDate(message.createdAt),
            metadata,
          };
          if (!isStopped) return user;
          const reply: ThreadMessageLike = {
            id: `${message.id}:stopped`,
            role: 'assistant',
            content: [],
            status: CANCELLED,
            createdAt: user.createdAt,
            metadata,
          };
          return [user, reply];
        });
        break;
      case 'event':
        emit([message], () => ({
          id: message.id,
          role: 'system',
          content: [{ type: 'text', text: message.text }],
          createdAt: toDate(message.createdAt),
          metadata: {
            custom: {
              kind: message.kind,
              ...(message.updateId ? { updateId: message.updateId } : {}),
              ...(message.detail ? { detail: message.detail } : {}),
              ...(message.unread ? { unread: true } : {}),
            },
          },
        }));
        break;
      case 'assistant':
      case 'reasoning':
      case 'tool': {
        let end = i + 1;
        while (end < messages.length && isAssistantSide(messages[end])) end++;
        const group = messages.slice(i, end);
        emit(group, (isStopped) => ({
          id: message.id,
          role: 'assistant',
          content: group.map(toAssistantPart),
          createdAt: toDate(message.createdAt),
          metadata: voice ? { modality: 'voice' } : undefined,
          ...(isStopped ? { status: CANCELLED } : {}),
        }));
        i = end - 1;
        break;
      }
    }
  }

  return { messages: result, cache };
}

/** An attachment as assistant-ui shows it: its content points at the stored file. */
export function toThreadAttachment(a: ChatAttachment) {
  const url = workspaceUrl(a.path);
  return {
    id: a.path,
    type: a.kind,
    name: a.name,
    contentType: a.mimeType,
    status: { type: 'complete' as const },
    content:
      a.kind === 'image'
        ? [{ type: 'image' as const, image: url, filename: a.name }]
        : [
            {
              type: 'file' as const,
              data: url,
              mimeType: a.mimeType ?? 'application/octet-stream',
              filename: a.name,
            },
          ],
  };
}

function isAssistantSide(message: ChatMessage) {
  return message.role === 'assistant' || message.role === 'reasoning' || message.role === 'tool';
}

function toAssistantPart(message: ChatMessage): AssistantPart {
  if (message.role === 'reasoning') return { type: 'reasoning', text: message.text };
  if (message.role === 'tool') {
    return {
      type: 'tool-call',
      toolCallId: message.toolCallId,
      toolName: message.name,
      args: parseArgs(message.args),
      argsText: message.args ?? '',
      result: message.result,
      isError: message.isError,
    };
  }
  return { type: 'text', text: message.role === 'assistant' ? message.text : '' };
}

function parseArgs(args: string | undefined) {
  if (!args) return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, never>)
      : {};
  } catch {
    return {};
  }
}

function toDate(value: string | undefined) {
  return value ? new Date(value) : undefined;
}
