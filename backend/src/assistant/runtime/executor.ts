import type { LettaCodeSession } from '@letta-ai/letta-agent-sdk';
import type { TurnMode } from '../../chat-types';
import { publish } from '../conversations/events.ts';
import type { CallStateFilter } from '../conversations/messages.ts';
import type { SessionReader } from './session-adapter';
import type { TurnRequest } from './types';

export interface TurnExecutorPorts {
  conversationId: string;
  session: LettaCodeSession;
  reader: SessionReader;
  request: TurnRequest;
  signal: AbortSignal;
  encoded: string;
  otid: string;
  turnId: string;
  mode: TurnMode;
  depth: number;
  markers: CallStateFilter | null;
  onNativeTool(
    call: { name: string; args: string } | undefined,
    result: { content: unknown; isError?: boolean },
    mode: TurnMode,
    depth: number
  ): Promise<void>;
  onSessionFailure(): void;
}

export interface TurnExecutionResult {
  text: string;
  error?: string;
  success: boolean;
  firstTokenAt: number | null;
  lastMessageId: string;
}

/** Execute one serialized turn against its prepared Letta session and stream. */
export async function executeTurn(ports: TurnExecutorPorts): Promise<TurnExecutionResult> {
  const {
    conversationId,
    session,
    reader,
    request,
    signal,
    encoded,
    otid,
    turnId,
    mode,
    depth,
    markers,
    onNativeTool,
    onSessionFailure,
  } = ports;
  const onAbort = () => void session.abort().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  let text = '';
  let error: string | undefined;
  let success = false;
  let firstTokenAt: number | null = null;
  let lastMessageId = otid;
  const announcedTools = new Set<string>();
  const toolCalls = new Map<string, { name: string; args: string }>();
  const emitText = (delta: string) => {
    if (!delta) return;
    text += delta;
    request.onText?.(delta);
    publish(conversationId, {
      type: 'assistant_delta',
      turnId,
      messageId: lastMessageId,
      text: delta,
    });
  };
  try {
    const messages = reader.nextTurn();
    const images = request.images ?? [];
    await session.send(images.length ? [{ type: 'text', text: encoded }, ...images] : encoded, {
      otid,
    });
    for await (const message of messages) {
      switch (message.type) {
        case 'reasoning':
          if (!message.content) break;
          publish(conversationId, {
            type: 'reasoning_delta',
            turnId,
            // uuid is the persisted message ID; otid correlates the whole turn.
            messageId: message.uuid,
            text: message.content,
          });
          break;
        case 'assistant':
          if (!message.content) break;
          firstTokenAt ??= performance.now();
          lastMessageId = message.uuid;
          emitText(markers ? markers.push(message.content) : message.content);
          break;
        case 'tool_call': {
          const call = toolCalls.get(message.toolCallId) ?? { name: message.toolName, args: '' };
          call.args = mergeToolArguments(call.args, message);
          toolCalls.set(message.toolCallId, call);
          if (announcedTools.has(message.toolCallId)) break;
          announcedTools.add(message.toolCallId);
          publish(conversationId, {
            type: 'tool_call',
            turnId,
            toolCallId: message.toolCallId,
            name: message.toolName,
          });
          break;
        }
        case 'tool_result':
          await onNativeTool(toolCalls.get(message.toolCallId), message, mode, depth);
          publish(conversationId, {
            type: 'tool_result',
            turnId,
            toolCallId: message.toolCallId,
            args: toolCalls.get(message.toolCallId)?.args || undefined,
            result: stringify(message.content).replace(/\[\[mcp-managed-artifacts:v1:[0-9a-f-]{36}\]\]/gi, ''),
            isError: Boolean(message.isError),
          });
          break;
        case 'error':
          error = message.message;
          break;
        case 'result':
          success = message.success;
          if (!message.success) {
            error ??= message.errorCode ?? message.error ?? 'turn failed';
            if (message.errorCode && BROKEN_SESSION_CODES.has(message.errorCode))
              onSessionFailure();
          }
          break;
      }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    onSessionFailure();
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (markers) emitText(markers.flush());
  return { text, error, success, firstTokenAt, lastMessageId };
}

const BROKEN_SESSION_CODES = new Set(['stream_closed', 'protocol_error']);

function mergeToolArguments(
  previous: string,
  message: { toolInput: Record<string, unknown>; rawArguments?: string }
): string {
  if (message.rawArguments !== undefined) return previous + message.rawArguments;
  const input = message.toolInput;
  if (typeof input.raw === 'string') return previous + input.raw;
  return Object.keys(input).length ? JSON.stringify(input) : previous;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .join('');
  }
  return JSON.stringify(value);
}
