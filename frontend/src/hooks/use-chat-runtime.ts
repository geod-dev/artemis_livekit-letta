import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AppendMessage,
  type ExternalStoreThreadData,
  type ThreadMessageLike,
  createMessageQueue,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import type { TextEffort } from '@shared/chat-types';
import type { useConversation } from '@/hooks/use-conversation';
import type { useConversations } from '@/hooks/use-conversations';
import { attachmentAdapter, sentAttachments } from '@/lib/attachment-adapter';
import { type ThreadMessageCache, toThreadMessages } from '@/lib/thread-messages';

// `lastMessageAt` is not part of the adapter's thread type, but the runtime
// copies thread fields onto its list items, where the thread list reads it to
// group conversations by day.
type ThreadData = ExternalStoreThreadData<'regular'> & { lastMessageAt?: Date };

interface ChatRuntimeOptions {
  list: ReturnType<typeof useConversations>;
  conversation: ReturnType<typeof useConversation>;
  activeId: string | null;
  select: (id: string | null) => void;
  /** Conversation the live voice call belongs to, flagged in the thread list. */
  callConversationId: string | null;
  effort: TextEffort;
}

const identity = (message: ThreadMessageLike) => message;
type ComposerContentPart = { type: string; text?: string };

/**
 * Bridges the conversation hooks (Letta history + SSE events) to assistant-ui
 * through an external store runtime: the hooks stay the source of truth and
 * assistant-ui renders them and reports user actions back.
 */
export function useChatRuntime({
  list,
  conversation,
  activeId,
  select,
  callConversationId,
  effort,
}: ChatRuntimeOptions) {
  const { create, rename, remove, deleteFromMessage } = list;
  const { send, cancel, showPending, expectNew, keepPending, rewind, setErrorFor } = conversation;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const cache = useRef<ThreadMessageCache>(new Map());
  const messages = useMemo(() => {
    const converted = toThreadMessages(conversation.messages, cache.current, conversation.stopped);
    cache.current = converted.cache;
    return converted.messages;
  }, [conversation.messages, conversation.stopped]);

  /** What a composed message sends: its text, attachments and the turn's effort. */
  const toTurn = useCallback(
    (message: AppendMessage) => {
      const text = message.content
        .flatMap((part: ComposerContentPart) =>
          part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
        )
        .join('\n\n')
        .trim();
      const attachments = sentAttachments(message.attachments);
      return { text, attachments, effort };
    },
    [effort]
  );

  /** Send a message; resolves false when no turn was requested. */
  const submit = useCallback(
    async (message: AppendMessage): Promise<boolean> => {
      const { text, attachments, effort: turnEffort } = toTurn(message);
      if (!text && attachments.length === 0) return false;
      if (activeId !== conversation.shownId) return false;
      showPending({ text, attachments });
      let id = activeId;
      if (!id) {
        // "New chat" is only a page: the conversation starts with its first message.
        try {
          id = (await create()).id;
        } catch (error) {
          showPending(null);
          throw error;
        }
        expectNew(id);
        select(id);
      }
      return send(id, text, turnEffort, attachments);
    },
    [activeId, conversation.shownId, create, expectNew, select, send, showPending, toTurn]
  );

  /**
   * Edit a user message: the conversation rolls back to before it (its history
   * moves to a fork, see onDelete) and the new version is sent there. Editing
   * the first message starts a new conversation.
   */
  const onEdit = useCallback(
    async (message: AppendMessage) => {
      const { text, attachments, effort: turnEffort } = toTurn(message);
      const sourceId = message.sourceId;
      if (
        !activeId ||
        conversation.shownId !== activeId ||
        !sourceId ||
        (!text && attachments.length === 0)
      )
        return;
      const restore = rewind(sourceId);
      showPending({ text, attachments });
      let id: string;
      try {
        const fork = await deleteFromMessage(activeId, sourceId);
        if (fork) {
          id = fork.id;
          keepPending(id);
        } else {
          id = (await create()).id;
          expectNew(id);
        }
      } catch (error) {
        if (activeIdRef.current === activeId) {
          restore();
          showPending(null);
          setErrorFor(
            activeId,
            error instanceof Error ? error.message : 'Could not edit the message'
          );
        }
        return;
      }
      if (activeIdRef.current !== activeId) return;
      select(id);
      await send(id, text, turnEffort, attachments);
    },
    [
      activeId,
      conversation.shownId,
      create,
      deleteFromMessage,
      expectNew,
      keepPending,
      rewind,
      select,
      send,
      setErrorFor,
      showPending,
      toTurn,
    ]
  );
  const onNew = useCallback(
    async (message: AppendMessage) => {
      await submit(message);
    },
    [submit]
  );

  // Turns are serialized server-side, but assistant-ui only sends while idle.
  // The queue holds messages typed during a turn (text or voice) and sends
  // them once it ends. It counts as busy from a dispatch until a turn settles,
  // so a send that never becomes a turn must release it.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const [queue] = useState(() => {
    const created = createMessageQueue({
      run: (message: AppendMessage) =>
        void submitRef
          .current(message)
          .catch(() => false)
          .then((accepted) => {
            if (!accepted) created.notifyIdle();
          }),
    });
    return created;
  });
  const isRunning = conversation.busy;
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    if (!wasRunning.current && isRunning) queue.notifyBusy();
    wasRunning.current = isRunning;
  }, [isRunning, queue]);
  // Every settled turn counts, including turns that failed before starting
  // (those never made the conversation busy).
  const settled = useRef(conversation.settledTurns);
  useEffect(() => {
    if (conversation.settledTurns === settled.current) return;
    settled.current = conversation.settledTurns;
    if (!isRunning) queue.notifyIdle();
  }, [conversation.settledTurns, isRunning, queue]);
  useEffect(() => queue.clear(), [activeId, queue]);

  const threads = useMemo(
    () =>
      list.conversations.map((c): ThreadData => ({
        status: 'regular',
        id: c.id,
        title: c.title,
        lastMessageAt: c.updatedAt ? new Date(c.updatedAt) : undefined,
        custom: { inCall: c.id === callConversationId, unread: c.unread ?? 0 },
      })),
    [list.conversations, callConversationId]
  );

  return useExternalStoreRuntime({
    messages,
    convertMessage: identity,
    isRunning,
    isLoading: conversation.loading,
    onNew,
    onEdit,
    onCancel: async () => {
      if (activeId && conversation.shownId === activeId) await cancel(activeId);
    },
    queue: queue.adapter,
    // Deleting a user message rolls the conversation back to before it (the
    // history moves to a new conversation, or the conversation goes away).
    onDelete: async (messageId: string) => {
      if (!activeId || conversation.shownId !== activeId) return;
      try {
        const next = await deleteFromMessage(activeId, messageId);
        if (activeIdRef.current !== activeId) return;
        select(next?.id ?? null);
      } catch (error) {
        setErrorFor(
          activeId,
          error instanceof Error ? error.message : 'Could not delete the message'
        );
      }
    },
    adapters: {
      attachments: attachmentAdapter,
      threadList: {
        threadId: activeId ?? undefined,
        isLoading: list.loading,
        threads,
        onSwitchToNewThread: () => select(null),
        onSwitchToThread: (id: string) => select(id),
        onRename: (id: string, title: string) => rename(id, title),
        onArchive: async (id: string) => {
          await remove(id);
          if (id === activeIdRef.current) select(null);
        },
      },
    },
  });
}
