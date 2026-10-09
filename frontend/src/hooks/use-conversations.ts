import { useCallback, useEffect, useState } from 'react';
import type { ConversationListEvent, ConversationSummary } from '@backend/chat-types';

/** The conversation list shown in the sidebar. */
export function useConversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? res.statusText);
      setConversations(body);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Unread background results change without the list being refetched.
  useEffect(() => {
    const source = new EventSource('/api/conversations/events');
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as ConversationListEvent;
      if (event.type !== 'unread') return;
      setConversations((list) =>
        list.map((c) => (c.id === event.conversationId ? { ...c, unread: event.unread } : c))
      );
    };
    return () => source.close();
  }, []);

  /** Insert or update one conversation and move it to the top. */
  const upsert = useCallback((conversation: ConversationSummary) => {
    setConversations((list) => [conversation, ...list.filter((c) => c.id !== conversation.id)]);
  }, []);

  const create = useCallback(async (): Promise<ConversationSummary> => {
    const res = await fetch('/api/conversations', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? 'Could not create conversation');
    upsert(body);
    return body;
  }, [upsert]);

  const rename = useCallback(async (id: string, title: string) => {
    const res = await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? 'Could not rename conversation');
    setConversations((list) => list.map((c) => (c.id === id ? body : c)));
  }, []);

  /** Archive a conversation (Letta keeps it, the list no longer shows it). */
  const remove = useCallback(async (id: string) => {
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    setConversations((list) => list.filter((c) => c.id !== id));
  }, []);

  /**
   * Delete a user message and everything after it. The history continues in a
   * new conversation, which replaces the old one in the list; resolves with it,
   * or null when the whole conversation was deleted.
   */
  const deleteFromMessage = useCallback(
    async (id: string, messageId: string): Promise<ConversationSummary | null> => {
      const res = await fetch(
        `/api/conversations/${id}/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE' }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Could not delete the message');
      const next = body.conversation as ConversationSummary | null;
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
