import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationListEvent, ConversationSummary } from '@shared/chat-types';
import { isRecord, requestJson, responseJson } from '@/lib/api';

const isSummary = (value: unknown): value is ConversationSummary =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.title === 'string' &&
  (value.updatedAt === null || typeof value.updatedAt === 'string');
const isSummaryList = (value: unknown): value is ConversationSummary[] =>
  Array.isArray(value) && value.every(isSummary);
const isListEvent = (value: unknown): value is ConversationListEvent =>
  isRecord(value) &&
  value.type === 'unread' &&
  typeof value.conversationId === 'string' &&
  typeof value.unread === 'number';

/** The conversation list shown in the sidebar. */
export function useConversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshRevision = useRef(0);
  const mutationRevision = useRef(0);

  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current;
    const beforeMutation = mutationRevision.current;
    try {
      const body = await requestJson(
        '/api/conversations',
        { cache: 'no-store' },
        isSummaryList,
        'Could not load conversations'
      );
      if (revision !== refreshRevision.current || beforeMutation !== mutationRevision.current)
        return;
      setConversations(body);
      setError(null);
    } catch (e) {
      if (revision === refreshRevision.current && beforeMutation === mutationRevision.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (revision === refreshRevision.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Unread background results change without the list being refetched.
  useEffect(() => {
    const source = new EventSource('/api/conversations/events');
    source.onmessage = (e) => {
      let event: unknown;
      try {
        event = JSON.parse(e.data);
      } catch {
        void refresh();
        return;
      }
      if (!isListEvent(event)) {
        void refresh();
        return;
      }
      setConversations((list) =>
        list.map((c) => (c.id === event.conversationId ? { ...c, unread: event.unread } : c))
      );
    };
    return () => source.close();
  }, [refresh]);

  /** Insert or update one conversation and move it to the top. */
  const upsert = useCallback((conversation: ConversationSummary) => {
    mutationRevision.current += 1;
    refreshRevision.current += 1;
    setConversations((list) => [conversation, ...list.filter((c) => c.id !== conversation.id)]);
  }, []);

  const create = useCallback(async (): Promise<ConversationSummary> => {
    const body = await requestJson(
      '/api/conversations',
      { method: 'POST' },
      isSummary,
      'Could not create conversation'
    );
    upsert(body);
    return body;
  }, [upsert]);

  const rename = useCallback(async (id: string, title: string) => {
    const revision = ++mutationRevision.current;
    refreshRevision.current += 1;
    const body = await requestJson(
      `/api/conversations/${id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
      isSummary,
      'Could not rename conversation'
    );
    if (revision !== mutationRevision.current) return;
    refreshRevision.current += 1;
    setConversations((list) => list.map((c) => (c.id === id ? body : c)));
  }, []);

  /** Archive a conversation (Letta keeps it, the list no longer shows it). */
  const remove = useCallback(async (id: string) => {
    const revision = ++mutationRevision.current;
    refreshRevision.current += 1;
    const response = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (!response.ok)
      await responseJson(
        response,
        (value): value is Record<string, unknown> => isRecord(value),
        'Could not archive conversation'
      );
    if (revision !== mutationRevision.current) return;
    refreshRevision.current += 1;
    setConversations((list) => list.filter((c) => c.id !== id));
  }, []);

  /**
   * Delete a user message and everything after it. The history continues in a
   * new conversation, which replaces the old one in the list; resolves with it,
   * or null when the whole conversation was deleted.
   */
  const deleteFromMessage = useCallback(
    async (id: string, messageId: string): Promise<ConversationSummary | null> => {
      const revision = ++mutationRevision.current;
      refreshRevision.current += 1;
      const res = await fetch(
        `/api/conversations/${id}/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE' }
      );
      const body = await responseJson(
        res,
        (value): value is { conversation: ConversationSummary | null } =>
          isRecord(value) && (value.conversation === null || isSummary(value.conversation)),
        'Could not delete the message'
      );
      if (revision !== mutationRevision.current) return body.conversation;
      refreshRevision.current += 1;
      const next = body.conversation;
      setConversations((list) => {
        const rest = list.filter((c) => c.id !== id);
        return next ? [next, ...rest] : rest;
      });
      return next;
    },
    []
  );

  return {
    conversations,
    loading,
    error,
    refresh,
    upsert,
    create,
    rename,
    remove,
    deleteFromMessage,
  };
}
