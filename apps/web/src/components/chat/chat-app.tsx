import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageCirclePlusIcon, PanelRightIcon } from 'lucide-react';
import type { ConversationSummary, TextEffort } from '@artemis/contracts/chat-types';
import { AssistantRuntimeProvider, AuiConfig, Tools } from '@assistant-ui/react';
import { RoomAudioRenderer, SessionProvider } from '@livekit/components-react';
import { Thread } from '@/components/chat-primitives/chat/thread';
import { generativeUIToolkit } from '@/components/chat-primitives/tools/generative-ui';
import {
  AppActivityContext,
  ChatThreadContext,
  type ChatThreadState,
  MascotElementContext,
  ToolRunActivityContext,
} from '@/components/chat/context';
import { LoadingBar } from '@/components/chat/loading-bar';
import { Sidebar } from '@/components/chat/sidebar';
import { WelcomeStats } from '@/components/chat/slots/welcome';
import { THREAD_COMPONENTS } from '@/components/chat/thread-slots';
import { WorkspaceFilePanelContext } from '@/components/files/workspace-file';
import {
  WorkspacePanel,
  type WorkspaceSelection,
  type WorkspaceTab,
} from '@/components/files/workspace-panel';
import { SettingsDialog } from '@/components/settings/settings-dialog';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { CallBar } from '@/components/voice/call-bar';
import { StartAudioButton } from '@/components/voice/start-audio-button';
import { useActivityTasks } from '@/hooks/use-activity';
import { useAppViewport } from '@/hooks/use-app-viewport';
import { useChatRuntime } from '@/hooks/use-chat-runtime';
import { useContextUsage } from '@/hooks/use-context-usage';
import { useConversation } from '@/hooks/use-conversation';
import { useConversations } from '@/hooks/use-conversations';
import { useSelectedConversation } from '@/hooks/use-selected-conversation';
import { useVoiceCall } from '@/hooks/use-voice-call';
import type { AgentRun } from '@/lib/agent-runs';

/** UI for the tools the agent runs (generative UI). */
const AUI_CONFIG = AuiConfig({ tools: Tools({ toolkit: generativeUIToolkit }) });

export function ChatApp({ assistantName }: { assistantName: string }) {
  useAppViewport();
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
  /** The mascot's element, shared with the atmosphere so it can measure the mascot. */
  const mascotRef = useRef<HTMLDivElement>(null);
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
  const openTask = useCallback((task: AgentRun) => {
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

  const { session, inCall, callConversationId, startCall, endCall } = useVoiceCall({
    activeId,
    list,
    conversation,
    select,
  });

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
            <AppActivityContext.Provider value={{ ...activity, openTask }}>
              <ToolRunActivityContext.Provider value={{ tasks: activity.tasks, openTask }}>
                <MascotElementContext.Provider value={mascotRef}>
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
                            autoFocus={
                              window.matchMedia('(hover: hover) and (pointer: fine)').matches
                            }
                            components={THREAD_COMPONENTS}
                            callButton={threadState.callButton}
                            contextUsage={contextUsage}
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
                </MascotElementContext.Provider>
              </ToolRunActivityContext.Provider>
            </AppActivityContext.Provider>
          </ChatThreadContext.Provider>
        </div>
        <SettingsDialog
          open={settingsOpen}
          assistantName={assistantName}
          onOpenChange={setSettingsOpen}
        />
      </AssistantRuntimeProvider>
      <StartAudioButton
        label="Allow audio playback"
        className="fixed bottom-24 left-1/2 -translate-x-1/2"
      />
      <Toaster position="top-center" />
    </SessionProvider>
  );
}
