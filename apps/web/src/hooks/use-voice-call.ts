import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TokenSource } from 'livekit-client';
import { CHAT_HTTP } from '@artemis/contracts/chat-http';
import type { ConversationSummary } from '@artemis/contracts/chat-types';
import { useSession } from '@livekit/components-react';
import type { useConversation } from '@/hooks/use-conversation';
import type { useConversations } from '@/hooks/use-conversations';
import { apiFetch } from '@/lib/api';

type ConversationList = ReturnType<typeof useConversations>;
type ActiveConversation = ReturnType<typeof useConversation>;

/**
 * The chat's voice call: its LiveKit session, whether it is connected, and the
 * conversation it runs on. A call from "new chat" starts a conversation first.
 */
export function useVoiceCall({
  activeId,
  list,
  conversation,
  select,
}: {
  activeId: string | null;
  list: Pick<ConversationList, 'upsert' | 'create'>;
  conversation: Pick<ActiveConversation, 'expectNew' | 'setError'>;
  select: (next: string | null) => void;
}) {
  const { upsert, create } = list;
  const { expectNew, setError } = conversation;
  // --- Voice call -----------------------------------------------------------
  // A literal token source is re-fetched on every start, so every call gets a
  // fresh room (and a fresh agent dispatch). LiveKit also fetches tokens on
  // its own (on mount to warm up, and after each call); those fetches carry no
  // call target and get a warm-up token with no side effects.
  const callTarget = useRef<string | null>(null);
  const [callConversationId, setCallConversationId] = useState<string | null>(null);
  const tokenSource = useMemo(
    () =>
      TokenSource.literal(async () => {
        const conversationId = callTarget.current;
        callTarget.current = null;
        const res = await apiFetch(CHAT_HTTP.voiceToken, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Calls from the web app are conversations: they stay open until ended.
          body: JSON.stringify({ conversationId: conversationId ?? undefined, mode: 'long' }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? 'Could not start the call');
        const target = body.conversation as ConversationSummary | null;
        if (target) {
          upsert(target);
          setCallConversationId(target.id);
        }
        return {
          serverUrl: body.serverUrl,
          participantToken: body.participantToken,
          participantName: body.participantName,
          roomName: body.roomName,
        };
      }),
    [upsert]
  );
  const session = useSession(tokenSource, { agentConnectTimeoutMilliseconds: 30_000 });
  const inCall = session.connectionState !== 'disconnected';

  const startCall = useCallback(async () => {
    try {
      // A call from "new chat" starts the conversation, like a first message does.
      let id = activeId;
      if (!id) {
        id = (await create()).id;
        expectNew(id);
        select(id);
      }
      callTarget.current = id;
      await session.start({ tracks: { microphone: { enabled: true } } });
    } catch (error) {
      console.error(error);
      setError(error instanceof Error ? error.message : 'Could not start the call');
      setCallConversationId(null);
    }
  }, [activeId, create, expectNew, select, session, setError]);

  const endCall = useCallback(async () => {
    await session.end();
    setCallConversationId(null);
  }, [session]);

  useEffect(() => {
    if (!inCall) setCallConversationId(null);
  }, [inCall]);
  return { session, inCall, callConversationId, startCall, endCall };
}
