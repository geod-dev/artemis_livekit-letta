import { type FC, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDownIcon,
  ArrowUpRightIcon,
  CodeIcon,
  CompassIcon,
  FileTextIcon,
  GitCompareArrowsIcon,
  LightbulbIcon,
  ListChecksIcon,
  PenLineIcon,
  RotateCwIcon,
} from 'lucide-react';
import {
  type AssistantState,
  AuiIf,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import { ThreadFollowupSuggestions } from '@/components/assistant-ui/chat/follow-up-suggestions';
import { ThreadMessage } from '@/components/assistant-ui/chat/messages';
import {
  EMPTY_COMPONENTS,
  ThreadComponentsContext,
  type ThreadProps,
} from '@/components/assistant-ui/chat/thread-context';
import { ThreadComposer } from '@/components/assistant-ui/composer/thread-composer';
import { IconButton } from '@/components/assistant-ui/shared/icon-button';
import { ConversationAtmosphere } from '@/components/chat/conversation-atmosphere';
import { Mascot } from '@/components/chat/mascot';
import {
  MascotEasterEggContext,
  MascotRecordingContext,
  WelcomeContinuation,
  useChatThread,
} from '@/components/chat/thread-slots';
import type { VoiceRecorderStatus } from '@/hooks/use-voice-recorder';
import { cn } from '@/lib/shadcn/utils';
import { pickWelcomeSuggestions } from '@/lib/welcome-suggestions';

export type { ThreadComponents, ThreadProps } from '@/components/assistant-ui/chat/thread-context';
// No messages: the new-chat page. A thread that is still loading (only when
// the app opens on a conversation) shows nothing until its messages arrive.
const isNewChatView = (s: AssistantState) => s.thread.messages.length === 0 && !s.thread.isLoading;

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  placeholder = 'Send a message...',
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} autoFocus={autoFocus} placeholder={placeholder} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{
  isEmpty: boolean;
  autoFocus: boolean;
  placeholder: string;
}> = ({ isEmpty, autoFocus, placeholder }) => {
  const aui = useAui();
  const {
    Welcome = ThreadWelcome,
    BeforeComposer,
    ComposerEffort,
  } = useContext(ThreadComponentsContext);
  const { callButton } = useChatThread();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [mascotEasterEgg, setMascotEasterEgg] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<VoiceRecorderStatus>('idle');
  // A new chat starts at the top, even when the previous conversation was
  // scrolled down. Keep this independent of mascot positioning.
  const threadId = useAuiState((s) => s.threadListItem.id);

  useEffect(() => {
    const focusComposerOnType = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        Array.from(event.key).length !== 1
      ) {
        return;
      }

      if (
        document.querySelector(
          'dialog[open], [aria-modal="true"], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
        )
      ) {
        return;
      }

      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        activeElement.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
        )
      ) {
        return;
      }

      const composerInput = document.querySelector<HTMLTextAreaElement>('.aui-composer-input');
      if (!composerInput) return;

      event.preventDefault();
      composerInput.focus({ preventScroll: true });
      const text = aui.composer.getState().text;
      const nextText = `${text}${event.key}`;
      aui.composer.setText(nextText);
      requestAnimationFrame(() => {
        composerInput.setSelectionRange(nextText.length, nextText.length);
      });
    };

    document.addEventListener('keydown', focusComposerOnType, true);
    return () => document.removeEventListener('keydown', focusComposerOnType, true);
  }, [aui]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!isEmpty || !viewport) return;
    // After a thread switch the viewport scrolls to the bottom on the next
    // frame, then again on every resize of its content, until a pointerdown
    // cancels it: cancel it that way, then go to the top. Repeated over two
    // frames, as the switch may be noticed after this effect.
    const toTop = () => {
      viewport.dispatchEvent(new PointerEvent('pointerdown'));
      viewport.scrollTo({ top: 0, behavior: 'instant' });
    };
    toTop();
    let frame = requestAnimationFrame(() => {
      toTop();
      frame = requestAnimationFrame(toTop);
    });
    return () => cancelAnimationFrame(frame);
  }, [isEmpty, threadId]);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container relative flex h-full flex-col"
      data-empty={isEmpty ? 'true' : undefined}
    >
      {!isEmpty && <ConversationAtmosphere viewportRef={viewportRef} />}
      <MascotEasterEggContext.Provider value={setMascotEasterEgg}>
        <MascotRecordingContext.Provider value={setRecordingStatus}>
          <ThreadPrimitive.Viewport
            // Bottom-anchored (the default): opens at the latest message, jumps to
            // the bottom on send, and follows a growing reply while the reader is
            // at the bottom. Not on a new chat, which stays at the top.
            turnAnchor="bottom"
            autoScroll={!isEmpty}
            ref={viewportRef}
            data-slot="aui_thread-viewport"
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
          >
            <div
              className={cn(
                'thread-column relative mx-auto flex w-full max-w-[48rem] flex-1 flex-col px-4 pt-4 md:px-8',
                // Optical centre sits above the geometric one: bias the block upward.
                isEmpty && 'thread-column-empty justify-center'
              )}
            >
              <AuiIf condition={isNewChatView}>
                <Welcome />
              </AuiIf>
              <AuiIf condition={(s) => s.thread.isLoading && s.thread.messages.length === 0}>
                <div className="thread-loading" role="status">
                  <span data-mascot-anchor="loading" className="block size-12" aria-hidden="true" />
                  <p>Picking up the thread…</p>
                </div>
              </AuiIf>

              <div
                data-slot="aui_message-group"
                className="mb-14 flex flex-col gap-y-6 empty:hidden"
              >
                <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
              </div>

              <ThreadPrimitive.ViewportFooter
                className={cn(
                  'aui-thread-viewport-footer flex flex-col gap-4 overflow-visible pb-[max(env(safe-area-inset-bottom),0.5rem)]',
                  isEmpty && 'aui-thread-empty-footer',
                  // The gap above the composer fades the messages out instead of cutting them off.
                  !isEmpty && 'sticky bottom-0 z-20 mt-auto pt-6'
                )}
              >
                <ThreadScrollToBottom />
                <ThreadFollowupSuggestions />
                {BeforeComposer && <BeforeComposer />}
                <ThreadComposer
                  autoFocus={autoFocus}
                  placeholder={placeholder}
                  docked={!isEmpty}
                  ComposerEffort={ComposerEffort}
                  callButton={callButton}
                />
                <AuiIf condition={isNewChatView}>
                  <ThreadSuggestions />
                </AuiIf>
              </ThreadPrimitive.ViewportFooter>
            </div>
          </ThreadPrimitive.Viewport>
          {/* One persistent mascot can travel between the chat and settings header. */}
          <Mascot
            viewportRef={viewportRef}
            easterEggEnabled={mascotEasterEgg}
            recordingStatus={recordingStatus}
          />
        </MascotRecordingContext.Provider>
      </MascotEasterEggContext.Provider>
    </ThreadPrimitive.Root>
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <IconButton
        label="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom bouncy bg-foreground text-background hover:bg-foreground hover:text-background absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </IconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col px-2">
      <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
        How can I help you today?
      </p>
    </div>
  );
};

// Stays mounted while typing (just hidden) so the centered composer does not
// move when the first character removes the suggestions.
const ThreadSuggestions: FC = () => {
  const aui = useAui();
  const composerEmpty = useAuiState((s) => s.composer.isEmpty);
  const [starters, setStarters] = useState(pickWelcomeSuggestions);
  const icons = {
    idea: LightbulbIcon,
    write: PenLineIcon,
    explore: CompassIcon,
    compare: GitCompareArrowsIcon,
    file: FileTextIcon,
    plan: ListChecksIcon,
    code: CodeIcon,
  };
  return (
    <div
      className={cn(
        'aui-thread-welcome-suggestions flex w-full flex-col transition-opacity duration-200',
        !composerEmpty && 'pointer-events-none opacity-0'
      )}
      aria-hidden={!composerEmpty}
    >
      {starters.map(({ label, icon, prompt }) => {
        const Icon = icons[icon];
        return (
          <button
            key={label}
            type="button"
            className="welcome-starter"
            tabIndex={composerEmpty ? 0 : -1}
            onClick={() => {
              aui.composer.setText(prompt);
              document
                .querySelector<HTMLTextAreaElement>('.aui-composer-input')
                ?.focus({ preventScroll: true });
            }}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
            <ArrowUpRightIcon className="starter-arrow" aria-hidden="true" />
          </button>
        );
      })}
      <div className="welcome-suggestions-footer">
        <WelcomeContinuation tabIndex={composerEmpty ? 0 : -1} />
        <button
          type="button"
          className="welcome-refresh"
          tabIndex={composerEmpty ? 0 : -1}
          onClick={() => setStarters(pickWelcomeSuggestions(starters))}
        >
          <RotateCwIcon aria-hidden="true" />
          More ideas
        </button>
      </div>
    </div>
  );
};
