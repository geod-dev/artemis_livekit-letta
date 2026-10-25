import { CHAT_HTTP } from '@artemis/contracts/chat-http';
import type {
  ChatAttachment,
  ChatMessage,
  ConversationEvent,
  TextEffort,
} from '@artemis/contracts/chat-types';
import {
  apiFetch,
  conversationRoute,
  isRecord,
  openEventSource,
  requestJson,
  responseJson,
} from '@/lib/api';
import { isChatMessage, isConversationEvent } from '@/lib/conversation-protocol';

/**
 * Transport for one conversation: its persisted history, its live event stream
 * and the requests that act on it. Plain functions, no React state; the hooks
 * decide what to show.
 */

/** A conversation's persisted messages, or null when they could not be loaded. */
export async function fetchHistory(
  id: string,
  signal?: AbortSignal
): Promise<ChatMessage[] | null> {
  try {
    const pages: ChatMessage[][] = [];
    const seenCursors = new Set<string>();
    let before: string | null = null;
    // Bound pagination in case a proxy or server returns a cursor cycle.
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const response = await apiFetch(`${conversationRoute(id, '/messages')}?${query}`, {
        cache: 'no-store',
        signal,
      });
      const rows = await responseJson(
        response,
        (value): value is ChatMessage[] => Array.isArray(value) && value.every(isChatMessage),
        'Could not load this conversation'
      );
      pages.unshift(rows);
      const cursor = response.headers.get('X-Next-Cursor');
      if (!cursor) return pages.flat();
      if (seenCursors.has(cursor)) return null;
      seenCursors.add(cursor);
      before = cursor;
    }
    return null;
  } catch {
    return null;
  }
}

/** Why an update from the live stream was not applied. */
export type RejectedUpdate = 'oversized' | 'invalid' | 'unsupported';

export interface ConversationStreamHandlers {
  /** The stream opened, including after each automatic retry. */
  onOpen: () => void;
  /** The stream failed; EventSource retries on its own. */
  onError: () => void;
  onEvent: (event: ConversationEvent) => void;
  onRejected: (reason: RejectedUpdate) => void;
}

/** Subscribe to a conversation's live events. Returns the function that closes it. */
export function openConversationStream(
  id: string,
  handlers: ConversationStreamHandlers
): () => void {
  const source = openEventSource(conversationRoute(id, CHAT_HTTP.conversationEvents));
  source.addEventListener('open', () => handlers.onOpen());
  source.onerror = () => handlers.onError();
  source.onmessage = (e) => {
    if (typeof e.data !== 'string' || e.data.length > 1_000_000) {
      handlers.onRejected('oversized');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      handlers.onRejected('invalid');
      return;
    }
    if (!isConversationEvent(parsed)) {
      handlers.onRejected('unsupported');
      return;
    }
    handlers.onEvent(parsed);
  };
  return () => source.close();
}

/** Post a text message; the reply arrives through the event stream. */
export function sendMessage(
  id: string,
  payload: {
    text: string;
    effort: TextEffort;
    attachments: ChatAttachment[];
    clientMessageId: string;
  }
): Promise<{ accepted: boolean }> {
  return requestJson(
    conversationRoute(id, '/messages'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    (value): value is { accepted: boolean } =>
      isRecord(value) && typeof value.accepted === 'boolean',
    'Failed to send'
  );
}

/** Stop the running turn; it ends through the event stream like any other. */
export function cancelTurn(id: string): Promise<{ cancelled: boolean }> {
  return requestJson(
    conversationRoute(id, '/cancel'),
    { method: 'POST' },
    (value): value is { cancelled: boolean } =>
      isRecord(value) && typeof value.cancelled === 'boolean',
    'Could not stop the response'
  );
}

/** Mark background updates as read. */
export function markUpdatesRead(id: string, updateIds: string[]): Promise<{ read: number }> {
  return requestJson(
    conversationRoute(id, '/read'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updateIds }),
    },
    (value): value is { read: number } => isRecord(value) && typeof value.read === 'number',
    'Could not mark updates as read'
  );
}
