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
  ConversationSummary,
  TextEffort,
} from '@artemis/contracts/chat-types';
import {
  cancelTurn,
  fetchHistory,
  markUpdatesRead,
  openConversationStream,
  sendMessage,
} from '@/lib/conversation-client';
import { mergeConversationMessages } from '@/lib/conversation-messages';
import {
  type ConversationStatePatch,
  type LiveConversationItem,
  type RunningTask,
  conversationStateReducer,
  initialConversationState,
} from '@/lib/conversation-state';
import {
  type StreamConnection,
  awaitStreamReady,
  subscribeToConversation,
} from '@/lib/conversation-subscription';

type LiveItem = LiveConversationItem;

type UserMessage = Extract<ChatMessage, { role: 'user' }>;

/**
 * One conversation as the UI sees it: persisted history plus live
 * events (text turns, voice turns, background task results) streamed over SSE.
 * Live items of a turn are replaced by the persisted history when it ends.
 *
 * Switching conversations keeps the previous one on screen until the next
 * one's history has loaded, then swaps everything at once. A message being
 * sent shows right away, before the server echoes it. The stream lifecycle
 * and event handling live in lib/conversation-subscription.ts; this hook
 * wires them to React state.
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
  const setTasks = useCallback<Dispatch<SetStateAction<RunningTask[]>>>(
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
  const connected = useRef<StreamConnection & { id: string | null }>({
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

    const activate = (rows: ChatMessage[]) => {
      ownerId.current = conversationId;
      dispatch({ type: 'activate', conversationId, history: rows });
    };
    if (!conversationId) {
      connected.current = { id: null, ready: Promise.resolve() };
      activate([]);
      return;
    }
    return subscribeToConversation(conversationId, isFresh, {
      connected,
      pending: pendingRef,
      pendingClientId,
      stopRequested,
      setError,
      setPending,
      setLive,
      setActiveTurns,
      setTasks,
      setSettledTurns,
      setStopped,
      bumpContextUsage: () => setContextUsageRevision((revision) => revision + 1),
      conversationUpdated: (conversation) => onUpdated.current?.(conversation),
      activate,
      dispatch,
      fetchHistory,
      openStream: openConversationStream,
    });
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
      try {
        const ready = await awaitStreamReady(id, {
          connection: () => connected.current,
          requested: () => requestedId.current,
        });
        if (!ready) return false;
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
        const response = await sendMessage(id, { text, effort, attachments, clientMessageId });
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
        const body = await cancelTurn(id);
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
            await markUpdatesRead(id, updateIds);
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
