import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TokenSource } from 'livekit-client';
import { MessageCirclePlusIcon, PanelRightIcon } from 'lucide-react';
import { AssistantRuntimeProvider, AuiConfig, Tools } from '@assistant-ui/react';
import { RoomAudioRenderer, SessionProvider, useSession } from '@livekit/components-react';
import type { ConversationSummary, TextEffort } from '@shared/chat-types';
import { StartAudioButton } from '@/components/agents-ui/start-audio-button';
import { Thread } from '@/components/assistant-ui/chat/thread';
import { WorkspaceFilePanelContext } from '@/components/assistant-ui/files/workspace-file';
import { generativeUIToolkit } from '@/components/assistant-ui/tools/generative-ui';
import { ActivityContext, type ActivityTask } from '@/components/chat/activity-context';
import { CallBar } from '@/components/chat/call-bar';
import { LoadingBar } from '@/components/chat/loading-bar';
import { Sidebar } from '@/components/chat/sidebar';
import {
  ChatThreadContext,
  type ChatThreadState,
  THREAD_COMPONENTS,
  WelcomeStats,
} from '@/components/chat/thread-slots';
import {
  WorkspacePanel,
  type WorkspaceSelection,
  type WorkspaceTab,
} from '@/components/chat/workspace-panel';
import { SettingsDialog } from '@/components/settings/settings-dialog';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { useActivityTasks } from '@/hooks/use-activity';
import { useChatRuntime } from '@/hooks/use-chat-runtime';
import { useContextUsage } from '@/hooks/use-context-usage';
import { useConversation } from '@/hooks/use-conversation';
import { useConversations } from '@/hooks/use-conversations';

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
      // Mobile browsers can pan the visual viewport to reveal a focused input.
      // Keep the app's top edge visible while its height follows the keyboard.
      document.documentElement.style.setProperty('--app-top', `${viewport?.offsetTop ?? 0}px`);
    };
    resize();
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      window.removeEventListener('resize', resize);
      document.documentElement.style.removeProperty('--app-height');
      document.documentElement.style.removeProperty('--app-top');
    };
  }, []);
  const list = useConversations();
  const { upsert, create } = list;
  const [activeId, select] = useSelectedConversation();
  const conversation = useConversation(activeId, upsert);
  const contextUsage = useContextUsage(conversation.shownId, conversation.contextUsageRevision);
  const { expectNew, setError } = conversation;
  const [effort, setEffort] = useState<TextEffort>('medium');
  const [effortLoaded, setEffortLoaded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const newChat = useCallback(() => select(null), [select]);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('files');
  const [workspaceSelection, setWorkspaceSelection] = useState<WorkspaceSelection>(null);
  const workspaceTrigger = useRef<HTMLButtonElement>(null);
  const activity = useActivityTasks(
    conversation.shownId,
    conversation.tasks,
    conversation.messages
  );
  const closeWorkspace = useCallback(() => {
    setWorkspaceOpen(false);
    requestAnimationFrame(() => workspaceTrigger.current?.focus());
  }, []);
  const setOpenFile = useCallback((path: string) => {
    setWorkspaceTab('files');
    setWorkspaceSelection({ type: 'file', path });
    setWorkspaceOpen(true);
  }, []);
  const openTask = useCallback((task: ActivityTask) => {
    setWorkspaceTab('tasks');
    setWorkspaceSelection({ type: 'task', task });
    setWorkspaceOpen(true);
  }, []);

  // An opened file belongs to the conversation it was linked from.
  useEffect(() => {
    setWorkspaceSelection(null);
    setWorkspaceOpen(false);
  }, [activeId]);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem('text-effort');
    } catch {
      // Storage can be disabled by the browser; use the in-memory default.
    }
    if (saved === 'low' || saved === 'medium' || saved === 'high') {
      setEffort(saved);
    }
    setEffortLoaded(true);
  }, []);
  useEffect(() => {
    if (effortLoaded) {
      try {
        window.localStorage.setItem('text-effort', effort);
      } catch {
        // The preference still applies for this session.
      }
    }
  }, [effort, effortLoaded]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k' || key === 'p') {
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

  // --- Text -----------------------------------------------------------------
  const runtime = useChatRuntime({
    list,
    conversation,
    activeId,
    select,
    callConversationId,
    effort,
  });

  const callOnCurrentConversation = inCall && callConversationId === activeId;
  const callButton = useMemo(
    () => ({
      label: inCall
        ? callOnCurrentConversation
          ? 'End call'
          : callConversationId
            ? 'Show active call'
            : 'Call is connecting'
        : 'Start a call',
      disabled: inCall && !callConversationId,
      active: callOnCurrentConversation,
      onClick: () => {
        if (!inCall) void startCall();
        else if (callOnCurrentConversation) void endCall();
        else if (callConversationId) select(callConversationId);
      },
    }),
    [callConversationId, callOnCurrentConversation, endCall, inCall, select, startCall]
  );

  const welcomeData = useMemo(() => {
    if (list.loading || list.error) return null;
    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    return {
      total: list.conversations.length,
      activeThisWeek: list.conversations.filter(
        (item) => Date.parse(item.updatedAt ?? '') >= weekStart.getTime()
      ).length,
    };
  }, [list.conversations, list.loading, list.error]);

  const threadState = useMemo<ChatThreadState>(
    () => ({
      assistantName,
      contextUsage,
      effort,
      setEffort,
      callButton,
      busy: conversation.busy,
      tasks: conversation.tasks,
      error: conversation.error,
      markRead: conversation.markRead,
      recentConversation: list.conversations.reduce<ConversationSummary | null>(
        (latest, item) =>
          !latest ||
          (Date.parse(item.updatedAt ?? '') || 0) > (Date.parse(latest.updatedAt ?? '') || 0)
            ? item
            : latest,
        null
      ),
      resumeConversation: select,
      conversationStats: welcomeData,
    }),
    [
      assistantName,
      contextUsage,
      effort,
      setEffort,
      callButton,
      conversation.busy,
      conversation.tasks,
      conversation.error,
      conversation.markRead,
      list.conversations,
      select,
      welcomeData,
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
        <LoadingBar active={conversation.loading} />
        <div className="app-shell text-foreground flex">
          <Sidebar
            assistantName={assistantName}
            error={list.error}
            searchOpen={searchOpen}
            onSearchOpenChange={setSearchOpen}
            newChatActive={activeId === null}
            settingsActive={settingsOpen}
            onNewChat={newChat}
            onSettings={openSettings}
          />
          <ChatThreadContext.Provider value={threadState}>
            <ActivityContext.Provider value={{ ...activity, openTask }}>
              <WorkspaceFilePanelContext.Provider value={setOpenFile}>
                <main className="app-main flex min-w-0 flex-1 flex-col">
                  <header
                    data-empty={conversation.blank || !shownId ? true : undefined}
                    className="app-topbar flex h-16 shrink-0 items-center justify-between gap-2 ps-16 pe-0.5 lg:gap-3 lg:px-6"
                  >
                    <div className="app-topbar-title min-w-0 flex-1">
                      {!conversation.blank && shownId && (
                        <h1
                          key={shownId}
                          className="font-display animate-pop-in min-w-0 truncate text-base font-medium tracking-tight sm:text-lg"
                        >
                          {shownTitle ?? 'Conversation'}
                        </h1>
                      )}
                    </div>
                    {(conversation.blank || !shownId) && <WelcomeStats />}
                    {!conversation.blank && shownId && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="New chat"
                        onClick={newChat}
                        className="mobile-new-chat-trigger ms-auto size-11 rounded-full lg:hidden"
                      >
                        <MessageCirclePlusIcon className="size-5" />
                      </Button>
                    )}
                    {activeId && (
                      <Button
                        ref={workspaceTrigger}
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={
                          workspaceOpen ? 'Close files and tasks' : 'Open files and tasks'
                        }
                        aria-expanded={workspaceOpen}
                        aria-controls={workspaceOpen ? 'conversation-workspace' : undefined}
                        onClick={() => setWorkspaceOpen((open) => !open)}
                        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted aria-expanded:bg-muted aria-expanded:text-foreground size-10 shrink-0 rounded-[var(--control-radius)] border-0 bg-transparent p-0 transition-colors duration-150"
                      >
                        <PanelRightIcon className="size-5" />
                      </Button>
                    )}
                  </header>
                  {inCall && <CallBar mascotActive={callOnCurrentConversation} />}
                  <div className="min-h-0 flex-1">
                    <WorkspaceFilePanelContext.Provider value={setOpenFile}>
                      <Thread
                        autoFocus={window.matchMedia('(hover: hover) and (pointer: fine)').matches}
                        components={THREAD_COMPONENTS}
                        placeholder={
                          inCall
                            ? 'Type here too, I’m still listening…'
                            : `An idea, a question, a little of everything…`
                        }
                      />
                    </WorkspaceFilePanelContext.Provider>
                  </div>
                </main>
                {activeId && workspaceOpen && (
                  <WorkspacePanel
                    tab={workspaceTab}
                    setTab={setWorkspaceTab}
                    selection={workspaceSelection}
                    setSelection={setWorkspaceSelection}
                    messages={conversation.messages}
                    error={activity.error}
                    onClose={closeWorkspace}
                  />
                )}
              </WorkspaceFilePanelContext.Provider>
            </ActivityContext.Provider>
          </ChatThreadContext.Provider>
        </div>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </AssistantRuntimeProvider>
      <StartAudioButton
        label="Allow audio playback"
        className="fixed bottom-24 left-1/2 -translate-x-1/2"
      />
      <Toaster position="top-center" />
    </SessionProvider>
  );
}
