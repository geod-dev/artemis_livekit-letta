import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type {
  ChatAttachment,
  ChatMessage,
  ConversationEvent,
  ConversationSummary,
  TextEffort,
} from '@shared/chat-types';
import { isRecord, requestJson, responseJson } from '@/lib/api';
import { historyCoversMessage, mergeConversationMessages } from '@/lib/conversation-messages';
import { isChatMessage, isConversationEvent } from '@/lib/conversation-protocol';
import {
  type ConversationStatePatch,
  type ConversationTaskStatus,
  type LiveConversationItem,
  conversationStateReducer,
  initialConversationState,
} from '@/lib/conversation-state';

type LiveItem = LiveConversationItem;
export type TaskStatus = ConversationTaskStatus;

type UserMessage = Extract<ChatMessage, { role: 'user' }>;

/** A conversation's persisted messages, or null when they could not be loaded. */
async function fetchHistory(id: string, signal?: AbortSignal): Promise<ChatMessage[] | null> {
  try {
    const pages: ChatMessage[][] = [];
    const seenCursors = new Set<string>();
    let before: string | null = null;
    // Bound pagination in case a proxy or server returns a cursor cycle.
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const response = await fetch(`/api/conversations/${id}/messages?${query}`, {
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
  const [state, dispatch] = useReducer(conversationStateReducer, initialConversationState);
  const [contextUsageRevision, setContextUsageRevision] = useState(0);
  const {
    conversationId: shownId,
    history,
    live,
    pending,
    activeTurns,
    tasks,
    settledTurns,
    stopped,
    error,
  } = state;
  const ownerId = useRef(state.conversationId);
  ownerId.current = state.conversationId;
  const patchState = useCallback((patch: ConversationStatePatch) => {
    dispatch({ type: 'patch', conversationId: ownerId.current, patch });
  }, []);
  const setHistory = useCallback<Dispatch<SetStateAction<ChatMessage[]>>>(
    (value) => patchState({ history: value }),
    [patchState]
  );
  const setLive = useCallback<Dispatch<SetStateAction<LiveItem[]>>>(
    (value) => patchState({ live: value }),
    [patchState]
  );
  const setPending = useCallback<Dispatch<SetStateAction<UserMessage | null>>>(
    (value) => patchState({ pending: value }),
    [patchState]
  );
  const setActiveTurns = useCallback<Dispatch<SetStateAction<string[]>>>(
    (value) => patchState({ activeTurns: value }),
    [patchState]
  );
  const setTasks = useCallback<Dispatch<SetStateAction<TaskStatus[]>>>(
    (value) => patchState({ tasks: value }),
    [patchState]
  );
  const setSettledTurns = useCallback<Dispatch<SetStateAction<number>>>(
    (value) => patchState({ settledTurns: value }),
    [patchState]
  );
  const setStopped = useCallback<Dispatch<SetStateAction<ReadonlySet<string>>>>(
    (value) => patchState({ stopped: value }),
    [patchState]
  );
  const setError = useCallback<Dispatch<SetStateAction<string | null>>>(
    (value) => patchState({ error: value }),
    [patchState]
  );
  const shownIdRef = useRef(shownId);
  shownIdRef.current = shownId;
  // Resolves once the event stream of a given conversation is open, so a message
  // sent right after creating a conversation cannot outrun its subscription.
  const connected = useRef<{ id: string | null; ready: Promise<void> }>({
    id: null,
    ready: Promise.resolve(),
  });
  const pendingClientId = useRef<string | null>(null);
  const requestedId = useRef(conversationId);
  requestedId.current = conversationId;
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

  const setErrorFor = useCallback(
    (id: string, message: string) => {
      if (shownIdRef.current === id) setError(message);
    },
    [setError]
  );

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
      ownerId.current = conversationId;
      dispatch({ type: 'activate', conversationId, history: rows });
    };
    if (!conversationId) {
      connected.current = { id: null, ready: Promise.resolve() };
      show([]);
      return;
    }

    let cancelled = false;
    let historyRevision = 0;
    let hasShown = false;
    const settledTurnIds = new Set<string>();
    const reconcileHistory = async (turnId?: string, stoppedByUser = false, started = false) => {
      const revision = ++historyRevision;
      dispatch({ type: 'history-requested', conversationId, revision });
      const rows = await fetchHistory(conversationId);
      if (cancelled || revision !== historyRevision) return false;
      if (!rows) {
        dispatch({
          type: 'history-failed',
          conversationId,
          revision,
          message: 'Could not refresh this conversation',
        });
        return false;
      }
      if (!hasShown) ready(rows);
      dispatch({ type: 'history-loaded', conversationId, revision, history: rows });
      if (turnId) {
        const persisted = new Map(rows.map((row) => [row.id, row]));
        setLive((items) =>
          items.filter((item) => {
            if (historyCoversMessage(persisted.get(item.message.id), item.message)) return false;
            if (item.turnId !== turnId) return true;
            // The provider may acknowledge completion before history exposes its
            // final rows. Keep the streamed answer until it is actually persisted.
            return item.message.role === 'assistant' || item.message.role === 'reasoning';
          })
        );
        if (stoppedByUser && started) {
          const last = rows.at(-1);
          if (last) setStopped((ids) => new Set(ids).add(last.id));
        }
      }
      return true;
    };
    /** Turns that sent their message here (read before the state catches up). */
    const startedTurns = new Set<string>();
    // Events wait until the history is on screen, then replay in order.
    let backlog: ConversationEvent[] | null = [];
    const ready = (rows: ChatMessage[]) => {
      if (cancelled) return;
      hasShown = true;
      show(rows);
      const held = backlog ?? [];
      backlog = null;
      held.forEach(processEvent);
    };
    if (isFresh) {
      ready([]);
    } else {
      const revision = ++historyRevision;
      void fetchHistory(conversationId).then((rows) => {
        if (revision !== historyRevision) return;
        ready(rows ?? []);
        if (!rows && !cancelled) {
          dispatch({
            type: 'history-failed',
            conversationId,
            revision,
            message: 'Could not load this conversation',
          });
        }
      });
    }

    const source = new EventSource(`/api/conversations/${conversationId}/events`);
    const makeGate = () => {
      let resolve!: () => void;
      let settled = false;
      const promise = new Promise<void>((done) => {
        resolve = () => {
          settled = true;
          done();
        };
      });
      return {
        promise,
        resolve,
        get settled() {
          return settled;
        },
      };
    };
    let gate = makeGate();
    // A subscription is only ready after each successful open, including retries.
    source.addEventListener('open', () => {
      setContextUsageRevision((revision) => revision + 1);
      gate.resolve();
      connected.current = { id: conversationId, ready: Promise.resolve() };
      setLive([]);
      setActiveTurns([]);
      setTasks([]);
      void reconcileHistory();
    });
    connected.current = { id: conversationId, ready: gate.promise };
    source.onerror = () => {
      // EventSource retries automatically. Keep sends waiting for the next open.
      if (connected.current.id === conversationId && gate.settled) {
        gate = makeGate();
        connected.current = { id: conversationId, ready: gate.promise };
      }
    };
    source.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data.length > 1_000_000) {
        setError('Received an oversized conversation update; refreshing…');
        void reconcileHistory();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        setError('Received an invalid conversation update; refreshing…');
        void reconcileHistory();
        return;
      }
      if (!isConversationEvent(parsed)) {
        setError('Received an unsupported conversation update; refreshing…');
        void reconcileHistory();
        return;
      }
      const event = parsed;
      if (backlog) backlog.push(event);
      else processEvent(event);
    };

    function processEvent(event: ConversationEvent) {
      try {
        handleEvent(event);
      } catch {
        setError('Could not apply a conversation update; refreshing…');
        void reconcileHistory();
      }
    }

    function handleEvent(event: ConversationEvent) {
      switch (event.type) {
        case 'context_usage':
          setContextUsageRevision((revision) => revision + 1);
          break;
        case 'snapshot':
          event.turns.forEach((turn) => startedTurns.add(turn.turnId));
          setActiveTurns([...new Set(event.turns.map((turn) => turn.turnId))]);
          setTasks(
            event.tasks
              .filter((task) => task.status === 'running')
              .map((task) => ({ id: task.taskId, title: task.title, status: 'running' as const }))
          );
          event.activeEvents.forEach(processEvent);
          break;
        case 'turn_start':
          startedTurns.add(event.turnId);
          setError(null);
          setActiveTurns((turns) =>
            turns.includes(event.turnId) ? turns : [...turns, event.turnId]
          );
          break;
        case 'message': {
          // Match the optimistic row by the server echoed client identity, then
          // keep the server's canonical message ID for history reconciliation.
          const shown = pendingRef.current;
          const isEcho = Boolean(
            shown &&
            event.message.role === 'user' &&
            event.message.clientMessageId &&
            event.message.clientMessageId === pendingClientId.current
          );
          const message = event.message;
          if (isEcho) {
            pendingClientId.current = null;
            setPending(null);
          }
          setLive((items) => [...items, { turnId: event.turnId, message }]);
          break;
        }
        case 'assistant_delta':
        case 'reasoning_delta': {
          const role = event.type === 'reasoning_delta' ? 'reasoning' : 'assistant';
          // Reasoning history rows use the same canonical prefix as the
          // assistant-ui adapter, while assistant rows use the message ID.
          const id = role === 'reasoning' ? `reasoning:${event.messageId}` : event.messageId;
          setLive((items) => {
            const index = items.findIndex((i) => i.message.id === id && i.message.role === role);
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
          if (!settledTurnIds.has(event.turnId)) {
            settledTurnIds.add(event.turnId);
            setActiveTurns((turns) => turns.filter((id) => id !== event.turnId));
            setSettledTurns((n) => n + 1);
          }
          // Failed or stopped before it started: its message was never sent.
          if (!started && pendingClientId.current) {
            pendingClientId.current = null;
            setPending(null);
          }
          const stoppedByUser = event.error === 'aborted' && stopRequested.current;
          if (stoppedByUser) stopRequested.current = false;
          // Swap this turn's live items for the canonical persisted rows.
          void reconcileHistory(event.turnId, stoppedByUser, started);
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
          // Completion notices can arrive during an autonomous Letta turn.
          // Refresh history without discarding its streamed response.
          void reconcileHistory();
          break;
        case 'conversation_updated':
          onUpdated.current?.(event.conversation);
          break;
      }
    }

    return () => {
      cancelled = true;
      gate.resolve();
      if (connected.current.id === conversationId)
        connected.current = { id: null, ready: Promise.resolve() };
      source.close();
    };
  }, [
    conversationId,
    dispatch,
    setActiveTurns,
    setError,
    setLive,
    setPending,
    setSettledTurns,
    setStopped,
    setTasks,
  ]);

  /** Call before selecting a conversation just created here: it shows at once. */
  const expectNew = useCallback((id: string) => {
    fresh.current = id;
    // Selection renders asynchronously; send() can run in this same callback.
    requestedId.current = id;
  }, []);

  /** Call before selecting the fork an edited message is sent to: it stays on screen. */
  const keepPending = useCallback((id: string) => {
    carry.current = id;
    requestedId.current = id;
  }, []);

  /**
   * Take a user message and everything after it off the screen (it is being
   * edited). Returns a function that puts them back.
   */
  const rewind = useCallback(
    (messageId: string) => {
      const before = historyRef.current;
      const index = before.findIndex((m) => m.id === messageId);
      if (index < 0) return () => undefined;
      setHistory(before.slice(0, index));
      setLive([]);
      return () => setHistory(before);
    },
    [setHistory, setLive]
  );

  /** Show a message on screen before it is sent (null takes it back). */
  const showPending = useCallback(
    (message: { text: string; attachments: ChatAttachment[] } | null) => {
      if (message) setError(null);
      setPending(
        message
          ? {
              id: `pending:${pendingClientId.current ?? (pendingClientId.current = crypto.randomUUID())}`,
              role: 'user',
              text: message.text,
              modality: 'text',
              clientMessageId: pendingClientId.current,
              ...(message.attachments.length ? { attachments: message.attachments } : {}),
            }
          : null
      );
      if (!message) pendingClientId.current = null;
    },
    [setError, setPending]
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
      const deadline = Date.now() + 15_000;
      try {
        while (connected.current.id !== id) {
          if (requestedId.current !== id) return false;
          if (Date.now() >= deadline)
            throw new Error('Could not connect to the conversation stream. Try sending again.');
          await new Promise((r) => setTimeout(r, 100));
        }
        const remaining = Math.max(0, deadline - Date.now());
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(
            () =>
              reject(new Error('Could not connect to the conversation stream. Try sending again.')),
            remaining
          );
          connected.current.ready.then(
            () => {
              window.clearTimeout(timer);
              resolve();
            },
            (error) => {
              window.clearTimeout(timer);
              reject(error);
            }
          );
        });
      } catch (error) {
        if (shownIdRef.current === id) {
          setPending(null);
          pendingClientId.current = null;
          setErrorFor(
            id,
            error instanceof Error ? error.message : 'Could not connect to the conversation stream'
          );
        }
        return false;
      }
      if (connected.current.id !== id) {
        if (shownIdRef.current === id) {
          setErrorFor(id, 'The conversation stream closed before the message could be sent');
          setPending(null);
          pendingClientId.current = null;
        }
        return false;
      }
      const clientMessageId = pendingClientId.current ?? crypto.randomUUID();
      try {
        const response = await requestJson(
          `/api/conversations/${id}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, effort, attachments, clientMessageId }),
          },
          (value): value is { accepted: boolean } =>
            isRecord(value) && typeof value.accepted === 'boolean',
          'Failed to send'
        );
        if (response.accepted) return true;
        throw new Error('The server did not accept the message');
      } catch (failure) {
        if (shownIdRef.current === id) {
          setPending(null);
          pendingClientId.current = null;
          setErrorFor(id, failure instanceof Error ? failure.message : 'Failed to send');
        }
        return false;
      }
    },
    [setErrorFor, setPending]
  );

  /** Stop the running turn; it ends through the event stream like any other. */
  const cancel = useCallback(
    async (id: string) => {
      stopRequested.current = true;
      try {
        const body = await requestJson(
          `/api/conversations/${id}/cancel`,
          { method: 'POST' },
          (value): value is { cancelled: boolean } =>
            isRecord(value) && typeof value.cancelled === 'boolean',
          'Could not stop the response'
        );
        if (!body.cancelled) stopRequested.current = false;
      } catch (error) {
        stopRequested.current = false;
        setErrorFor(id, error instanceof Error ? error.message : 'Could not stop the response');
      }
    },
    [setErrorFor]
  );

  /** Background updates (and their responses) the user has now seen on screen. */
  const markRead = useCallback(
    (updateIds: string[]) => {
      const id = shownId;
      if (!id || updateIds.length === 0) return;
      const before = historyRef.current;
      const read = new Set(updateIds);
      setHistory((rows) =>
        rows.map((row) =>
          row.role === 'event' && row.updateId && read.has(row.updateId) && row.unread
            ? { ...row, unread: false }
            : row
        )
      );
      void (async () => {
        let failure: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await requestJson(
              `/api/conversations/${id}/read`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ updateIds }),
              },
              (value): value is { read: number } =>
                isRecord(value) && typeof value.read === 'number',
              'Could not mark updates as read'
            );
            return;
          } catch (error) {
            failure = error;
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (shownIdRef.current !== id) return;
        setHistory((rows) =>
          rows.map((row) => {
            const original = before.find((candidate) => candidate.id === row.id);
            return original?.role === 'event' &&
              row.role === 'event' &&
              original.updateId &&
              read.has(original.updateId)
              ? { ...row, unread: original.unread }
              : row;
          })
        );
        setError(failure instanceof Error ? failure.message : 'Could not mark updates as read');
      })();
    },
    [setError, setHistory, shownId]
  );

  const messages = useMemo(
    () => mergeConversationMessages(history, live, pending),
    [history, live, pending]
  );

  return {
    shownId: shownId ?? null,
    contextUsageRevision,
    messages,
    busy: activeTurns.length > 0 || pending !== null,
    settledTurns,
    stopped,
    tasks,
    error,
    historyStatus: state.historyRequest.status,
    /** The selected conversation is not on screen yet. */
    loading: conversationId !== (shownId ?? null),
    /** Nothing on screen yet: the app opened on a conversation still loading. */
    blank: shownId === undefined && conversationId !== null,
    expectNew,
    keepPending,
    rewind,
    showPending,
    setError,
    setErrorFor,
    send,
    cancel,
    markRead,
  };
}
