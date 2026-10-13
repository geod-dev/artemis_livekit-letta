import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TokenSource } from 'livekit-client';
import { PhoneIcon, PhoneOffIcon } from 'lucide-react';
import { AssistantRuntimeProvider, AuiConfig, Tools } from '@assistant-ui/react';
import type { ConversationSummary, TextEffort } from '@backend/chat-types';
import { RoomAudioRenderer, SessionProvider, useSession } from '@livekit/components-react';
import { StartAudioButton } from '@/components/agents-ui/start-audio-button';
import { generativeUIToolkit } from '@/components/assistant-ui/elements/generative-ui';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { TooltipIconButton } from '@/components/assistant-ui/elements/tooltip-icon-button';
import { WorkspaceFilePanelContext } from '@/components/assistant-ui/elements/workspace-file';
import { WorkspaceFilePanel } from '@/components/assistant-ui/elements/workspace-file-panel';
import { CallBar } from '@/components/chat/call-bar';
import { LoadingBar } from '@/components/chat/loading-bar';
import { Sidebar } from '@/components/chat/sidebar';
import {
  ChatThreadContext,
  type ChatThreadState,
  THREAD_COMPONENTS,
} from '@/components/chat/thread-slots';
import { SettingsDialog } from '@/components/settings/settings-dialog';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatRuntime } from '@/hooks/use-chat-runtime';
import { useConversation } from '@/hooks/use-conversation';
import { useConversations } from '@/hooks/use-conversations';
import { hasAttachments } from '@/lib/attachments';

/** UI for the tools Letta runs (generative UI). */
const AUI_CONFIG = AuiConfig({ tools: Tools({ toolkit: generativeUIToolkit }) });

/** Keep the selected conversation in `?c=<id>` without remounting anything. */
function useSelectedConversation() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    setId(new URLSearchParams(window.location.search).get('c'));
    const onPop = () => setId(new URLSearchParams(window.location.search).get('c'));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const select = useCallback((next: string | null) => {
    setId(next);
    const url = next ? `?c=${encodeURIComponent(next)}` : window.location.pathname;
    window.history.pushState(null, '', url);
  }, []);
  return [id, select] as const;
}

export function ChatApp({ assistantName }: { assistantName: string }) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      document.documentElement.style.setProperty(
        '--app-height',
        `${viewport?.height ?? window.innerHeight}px`
      );
    };
    resize();
    viewport?.addEventListener('resize', resize);
    window.addEventListener('resize', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      window.removeEventListener('resize', resize);
      document.documentElement.style.removeProperty('--app-height');
    };
  }, []);
  const list = useConversations();
  const { upsert, create } = list;
  const [activeId, select] = useSelectedConversation();
  const conversation = useConversation(activeId, upsert);
  const { expectNew } = conversation;
  const [effort, setEffort] = useState<TextEffort>('medium');
  const [effortLoaded, setEffortLoaded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const newChat = useCallback(() => select(null), [select]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const closeFile = useCallback(() => setOpenFile(null), []);

  // An opened file belongs to the conversation it was linked from.
  useEffect(() => setOpenFile(null), [activeId]);

  useEffect(() => {
    const saved = window.localStorage.getItem('text-effort');
    if (saved === 'fast' || saved === 'low' || saved === 'medium' || saved === 'high') {
      setEffort(saved);
    }
    setEffortLoaded(true);
  }, []);
  useEffect(() => {
    if (effortLoaded) window.localStorage.setItem('text-effort', effort);
  }, [effort, effortLoaded]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      } else if (key === 'n') {
        event.preventDefault();
        select(null);
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [select]);

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
        const res = await fetch('/api/voice/token', {
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
      setCallConversationId(null);
    }
  }, [activeId, create, expectNew, select, session]);

  const endCall = useCallback(async () => {
    await session.end();
    setCallConversationId(null);
  }, [session]);

  useEffect(() => {
    if (!inCall) setCallConversationId(null);
  }, [inCall]);

  // --- Text -----------------------------------------------------------------
  const runtime = useChatRuntime({
    list,
    conversation,
    activeId,
    select,
    callConversationId,
    effort,
  });

  // Chats with attachments stay on the smart model: no Instant, no calls.
  const withAttachments = useMemo(
    () => hasAttachments(conversation.messages),
    [conversation.messages]
  );
  const callBlocked = !inCall && withAttachments;

  const threadState = useMemo<ChatThreadState>(
    () => ({
      assistantName,
      effort,
      setEffort,
      withAttachments,
      busy: conversation.busy,
      tasks: conversation.tasks,
      error: conversation.error,
      markRead: conversation.markRead,
    }),
    [
      assistantName,
      effort,
      setEffort,
      withAttachments,
      conversation.busy,
      conversation.tasks,
      conversation.error,
      conversation.markRead,
    ]
  );

  // The page follows the conversation on screen, which trails the selection
  // while the next one loads.
  const shownId = conversation.shownId;
  const shownTitle = list.conversations.find((c) => c.id === shownId)?.title;

  return (
    <SessionProvider session={session}>
      <RoomAudioRenderer />
      <AssistantRuntimeProvider runtime={runtime} config={AUI_CONFIG}>
        <TooltipProvider>
          <LoadingBar active={conversation.loading} />
          <div className="app-shell text-foreground flex">
            <Sidebar
              assistantName={assistantName}
              error={list.error}
              searchOpen={searchOpen}
              onSearchOpenChange={setSearchOpen}
              newChatActive={activeId === null}
              onNewChat={newChat}
              onSettings={openSettings}
            />
            <main className="bg-background flex min-w-0 flex-1 flex-col">
              <header className="flex h-16 shrink-0 items-center justify-between gap-2 ps-16 pe-3 lg:gap-3 lg:px-6">
                {!conversation.blank && shownId && (
                  <h1
                    key={shownId}
                    className="font-display animate-rise-in min-w-0 truncate text-base font-extrabold sm:text-xl"
                  >
                    {shownTitle ?? 'Conversation'}
                  </h1>
                )}
                <TooltipIconButton
                  tooltip={
                    inCall
                      ? callConversationId === activeId
                        ? 'End call'
                        : 'Show active call'
                      : callBlocked
                        ? 'Calls are not available in chats with attachments'
                        : 'Start a call'
                  }
                  side="bottom"
                  type="button"
                  aria-label={
                    inCall
                      ? callConversationId === activeId
                        ? 'End call'
                        : 'Show active call'
                      : 'Start a call'
                  }
                  onClick={() => {
                    if (!inCall) void startCall();
                    else if (callConversationId === activeId) void endCall();
                    else if (callConversationId) select(callConversationId);
                  }}
                  disabled={(inCall && !callConversationId) || callBlocked}
                  className={
                    inCall && callConversationId === activeId
                      ? 'bg-mint hover:bg-destructive ms-auto size-9 rounded-full text-white hover:text-white'
                      : 'text-muted-foreground hover:bg-mint ms-auto size-9 rounded-full hover:text-white'
                  }
                >
                  {inCall && callConversationId === activeId ? (
                    <PhoneOffIcon className="size-4" />
                  ) : (
                    <PhoneIcon className="size-4" />
                  )}
                </TooltipIconButton>
              </header>
              {inCall && <CallBar />}
              <div className="min-h-0 flex-1">
                <ChatThreadContext.Provider value={threadState}>
                  <WorkspaceFilePanelContext.Provider value={setOpenFile}>
                    <Thread
                      autoFocus={window.matchMedia('(hover: hover) and (pointer: fine)').matches}
                      components={THREAD_COMPONENTS}
                      placeholder={
                        inCall
                          ? 'Type here too, I’m still listening…'
                          : `Tell ${assistantName} what’s up…`
                      }
                    />
                  </WorkspaceFilePanelContext.Provider>
                </ChatThreadContext.Provider>
              </div>
            </main>
            {openFile && (
              // Workspace files linked from a markdown document open in the panel too.
              <WorkspaceFilePanelContext.Provider value={setOpenFile}>
                <WorkspaceFilePanel path={openFile} onClose={closeFile} />
              </WorkspaceFilePanelContext.Provider>
            )}
          </div>
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        </TooltipProvider>
      </AssistantRuntimeProvider>
      <StartAudioButton
        label="Allow audio playback"
        className="fixed bottom-24 left-1/2 -translate-x-1/2"
      />
      <Toaster position="top-center" />
    </SessionProvider>
  );
}
