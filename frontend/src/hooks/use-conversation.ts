import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatAttachment,
  ChatMessage,
  ConversationEvent,
  ConversationSummary,
  TextEffort,
} from '@backend/chat-types';

interface LiveItem {
  turnId: string;
  message: ChatMessage;
}

export interface TaskStatus {
  id: string;
  title: string;
  status: 'running';
}

type UserMessage = Extract<ChatMessage, { role: 'user' }>;

/** A conversation's persisted messages, or null when they could not be loaded. */
async function fetchHistory(id: string): Promise<ChatMessage[] | null> {
  const res = await fetch(`/api/conversations/${id}/messages`, { cache: 'no-store' }).catch(
    () => null
  );
  return res?.ok ? res.json() : null;
}

/**
 * One conversation as the UI sees it: persisted history from Letta plus live
 * events (text turns, voice turns, background task results) streamed over SSE.
 * Live items of a turn are replaced by the persisted history when it ends.
 *
 * Switching conversations keeps the previous one on screen until the next
 * one's history has loaded, then swaps everything at once. A message being
 * sent shows right away, before the server echoes it.
 */
export function useConversation(
  conversationId: string | null,
  onConversationUpdated?: (c: ConversationSummary) => void
) {
  /** The conversation on screen; undefined until the first one is shown. */
  const [shownId, setShownId] = useState<string | null | undefined>(undefined);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<LiveItem[]>([]);
  const [pending, setPending] = useState<UserMessage | null>(null);
  const [activeTurns, setActiveTurns] = useState<string[]>([]);
  const [tasks, setTasks] = useState<TaskStatus[]>([]);
  /** Counts finished turns, including turns that failed before they started. */
  const [settledTurns, setSettledTurns] = useState(0);
  /** Last rows of turns the user stopped (see `stopped` in toThreadMessages). */
  const [stopped, setStopped] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  // Resolves once the event stream of a given conversation is open, so a message
  // sent right after creating a conversation cannot outrun its subscription.
  const connected = useRef<{ id: string | null; ready: Promise<void> }>({
    id: null,
    ready: Promise.resolve(),
  });
  /** A conversation just created here: empty, so it is shown without loading. */
  const fresh = useRef<string | null>(null);
  /** A conversation the pending message goes to (an edit's fork). */
  const carry = useRef<string | null>(null);
  /** The user pressed stop: the turn that ends aborted was stopped by them. */
  const stopRequested = useRef(false);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const historyRef = useRef(history);
  historyRef.current = history;
  const activeTurnsRef = useRef(activeTurns);
  activeTurnsRef.current = activeTurns;
  const onUpdated = useRef(onConversationUpdated);
  onUpdated.current = onConversationUpdated;

  useEffect(() => {
    const isFresh = conversationId !== null && fresh.current === conversationId;
    const isCarried = conversationId !== null && carry.current === conversationId;
    fresh.current = null;
    carry.current = null;
    stopRequested.current = false;
    // A message sent from the new-chat page carries over to the conversation
    // it creates, and an edited message to the fork it continues in; any
    // other switch drops it.
    if (!isFresh && !isCarried) setPending(null);

    const show = (rows: ChatMessage[]) => {
      setShownId(conversationId);
      setHistory(rows);
      setLive([]);
      setActiveTurns([]);
      setTasks([]);
      setError(null);
    };
    if (!conversationId) {
      show([]);
      return;
    }

    let cancelled = false;
    /** Turns that sent their message here (read before the state catches up). */
    const startedTurns = new Set<string>();
    // Events wait until the history is on screen, then replay in order.
    let backlog: ConversationEvent[] | null = [];
    const ready = (rows: ChatMessage[]) => {
      if (cancelled) return;
      show(rows);
      const held = backlog ?? [];
      backlog = null;
      held.forEach(handleEvent);
    };
    if (isFresh) {
      ready([]);
    } else {
      void fetchHistory(conversationId).then((rows) => {
        ready(rows ?? []);
        if (!rows && !cancelled) setError('Could not load this conversation');
      });
    }

    const source = new EventSource(`/api/conversations/${conversationId}/events`);
    connected.current = {
      id: conversationId,
      ready: new Promise((resolve) => {
        source.addEventListener('open', () => resolve(), { once: true });
        setTimeout(resolve, 3000);
      }),
    };
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as ConversationEvent;
      if (backlog) backlog.push(event);
      else handleEvent(event);
    };

    function handleEvent(event: ConversationEvent) {
      switch (event.type) {
        case 'turn_start':
          startedTurns.add(event.turnId);
          setError(null);
          setActiveTurns((t) => [...t, event.turnId]);
          break;
        case 'message': {
          // The echo of the pending message takes its place under the same
          // id, so it is not drawn a second time.
          const shown = pendingRef.current;
          const isEcho =
            shown &&
            event.message.role === 'user' &&
            event.message.text === shown.text &&
            (event.message.attachments?.length ?? 0) === (shown.attachments?.length ?? 0);
          const message = isEcho ? { ...event.message, id: shown.id } : event.message;
          if (isEcho) setPending(null);
          setLive((items) => [...items, { turnId: event.turnId, message }]);
          break;
        }
        case 'assistant_delta':
        case 'reasoning_delta': {
          const role = event.type === 'reasoning_delta' ? 'reasoning' : 'assistant';
          const id = `${event.turnId}:${role}:${event.messageId}`;
          setLive((items) => {
            const index = items.findIndex((i) => i.message.id === id);
            if (index < 0) {
              return [...items, { turnId: event.turnId, message: { id, role, text: event.text } }];
            }
            const item = items[index];
            const next = [...items];
            next[index] = {
              ...item,
              message: {
                ...item.message,
                text: (item.message as { text: string }).text + event.text,
              } as ChatMessage,
            };
            return next;
          });
          break;
        }
        case 'tool_call':
          setLive((items) => [
            ...items,
            {
              turnId: event.turnId,
              message: {
                id: event.toolCallId,
                role: 'tool',
                toolCallId: event.toolCallId,
                name: event.name,
              },
            },
          ]);
          break;
        case 'tool_result':
          setLive((items) =>
            items.map((i) =>
              i.message.role === 'tool' && i.message.toolCallId === event.toolCallId
                ? {
                    ...i,
                    message: {
                      ...i.message,
                      args: event.args ?? i.message.args,
                      result: event.result,
                      isError: event.isError,
                    },
                  }
                : i
            )
          );
          break;
        case 'turn_end': {
          if (!event.success && event.error && event.error !== 'aborted') setError(event.error);
          const started = startedTurns.delete(event.turnId);
          // Failed or stopped before it started: its message was never sent.
          if (!started) setPending(null);
          const stoppedByUser = event.error === 'aborted' && stopRequested.current;
          if (stoppedByUser) stopRequested.current = false;
          // Swap this turn's live items for the canonical persisted rows.
          void fetchHistory(conversationId!).then((rows) => {
            if (cancelled) return;
            if (rows) setHistory(rows);
            const last = rows?.at(-1);
            if (stoppedByUser && started && last) setStopped((ids) => new Set(ids).add(last.id));
            setLive((items) => items.filter((i) => i.turnId !== event.turnId));
            setActiveTurns((t) => t.filter((id) => id !== event.turnId));
            setSettledTurns((n) => n + 1);
          });
          break;
        }
        case 'task':
          setTasks((ts) => {
            const rest = ts.filter((t) => t.id !== event.taskId);
            return event.status === 'running'
              ? [...rest, { id: event.taskId, title: event.title, status: event.status }]
              : rest;
          });
          break;
        case 'updates_changed':
          // Held results and read markers; a running turn refetches when it ends.
          if (activeTurnsRef.current.length > 0) break;
          void fetchHistory(conversationId!).then((rows) => {
            if (!cancelled && rows) setHistory(rows);
          });
          break;
        case 'conversation_updated':
          onUpdated.current?.(event.conversation);
          break;
      }
    }

    return () => {
      cancelled = true;
      source.close();
    };
  }, [conversationId]);

  /** Call before selecting a conversation just created here: it shows at once. */
  const expectNew = useCallback((id: string) => {
    fresh.current = id;
  }, []);

  /** Call before selecting the fork an edited message is sent to: it stays on screen. */
  const keepPending = useCallback((id: string) => {
    carry.current = id;
  }, []);

  /**
   * Take a user message and everything after it off the screen (it is being
   * edited). Returns a function that puts them back.
   */
  const rewind = useCallback((messageId: string) => {
    const before = historyRef.current;
    const index = before.findIndex((m) => m.id === messageId);
    if (index < 0) return () => undefined;
    setHistory(before.slice(0, index));
    setLive([]);
    return () => setHistory(before);
  }, []);

  /** Show a message on screen before it is sent (null takes it back). */
  const showPending = useCallback(
    (message: { text: string; attachments: ChatAttachment[] } | null) => {
      if (message) setError(null);
      setPending(
        message
          ? {
              id: `pending:${crypto.randomUUID()}`,
              role: 'user',
              text: message.text,
              modality: 'text',
              ...(message.attachments.length ? { attachments: message.attachments } : {}),
            }
          : null
      );
    },
    []
  );

  /**
   * Post a text message (the reply arrives through the event stream). Resolves
   * false when the server did not accept it.
   */
  const send = useCallback(
    async (
      id: string,
      text: string,
      effort: TextEffort,
      attachments: ChatAttachment[] = []
    ): Promise<boolean> => {
      for (let i = 0; i < 30 && connected.current.id !== id; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await connected.current.ready;
      const res = await fetch(`/api/conversations/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, effort, attachments }),
      }).catch(() => null);
      if (!res?.ok) {
        setPending(null);
        setError((await res?.json().catch(() => null))?.error ?? 'Failed to send');
      }
      return Boolean(res?.ok);
    },
    []
  );

  /** Stop the running turn; it ends through the event stream like any other. */
  const cancel = useCallback(async (id: string) => {
    stopRequested.current = true;
    const res = await fetch(`/api/conversations/${id}/cancel`, { method: 'POST' }).catch(
      () => null
    );
    const body = (await res?.json().catch(() => null)) as { cancelled?: boolean } | null;
    if (!body?.cancelled) stopRequested.current = false;
  }, []);

  /** Background updates (and their responses) the user has now seen on screen. */
  const markRead = useCallback(
    (updateIds: string[]) => {
      const id = shownId;
      if (!id || updateIds.length === 0) return;
      const read = new Set(updateIds);
      setHistory((rows) =>
        rows.map((row) =>
          row.role === 'event' && row.updateId && read.has(row.updateId) && row.unread
            ? { ...row, unread: false }
            : row
        )
      );
      void fetch(`/api/conversations/${id}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updateIds }),
      }).catch(() => undefined);
    },
    [shownId]
  );

  const messages = useMemo(
    () => [...history, ...live.map((i) => i.message), ...(pending ? [pending] : [])],
    [history, live, pending]
  );

  return {
    shownId: shownId ?? null,
    messages,
    busy: activeTurns.length > 0 || pending !== null,
    settledTurns,
    stopped,
    tasks,
    error,
    /** The selected conversation is not on screen yet. */
    loading: conversationId !== (shownId ?? null),
    /** Nothing on screen yet: the app opened on a conversation still loading. */
    blank: shownId === undefined && conversationId !== null,
    expectNew,
    keepPending,
    rewind,
    showPending,
    setError,
    send,
    cancel,
    markRead,
  };
}
