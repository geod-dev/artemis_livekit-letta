import {
  type ComponentType,
  type FC,
  type PropsWithChildren,
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  AudioLinesIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PhoneIcon,
  PhoneOffIcon,
  RefreshCwIcon,
  SquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TrashIcon,
} from 'lucide-react';
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  type AssistantState,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  groupPartByType,
  useAui,
  useAuiState,
} from '@assistant-ui/react';
import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from '@/components/assistant-ui/elements/attachment.aui';
import {
  ComposerVoice,
  ComposerVoiceButton,
} from '@/components/assistant-ui/elements/composer-voice';
import { DayHeader } from '@/components/assistant-ui/elements/day-separator';
import { File } from '@/components/assistant-ui/elements/file';
import { ThreadFollowupSuggestions } from '@/components/assistant-ui/elements/follow-up-suggestions.aui';
import { Image } from '@/components/assistant-ui/elements/image';
import {
  MarkdownText,
  MessageLinkPreviews,
} from '@/components/assistant-ui/elements/markdown-text';
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from '@/components/assistant-ui/elements/reasoning.aui';
import { field, mono } from '@/components/assistant-ui/elements/surfaces';
import {
  type ToolCall,
  getToolGroupDisplay,
  getToolGroupLabel,
  toolCall,
} from '@/components/assistant-ui/elements/tool-display';
import { ToolFallback } from '@/components/assistant-ui/elements/tool-fallback.aui';
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from '@/components/assistant-ui/elements/tool-group.aui';
import { TooltipIconButton } from '@/components/assistant-ui/elements/tooltip-icon-button';
import { Mascot } from '@/components/chat/mascot';
import { MascotEasterEggContext, useChatThread } from '@/components/chat/thread-slots';
import { Button } from '@/components/ui/button';
import { useVoiceRecorder } from '@/hooks/use-voice-recorder';
import { dayKey, dayLabel, timeLabel } from '@/lib/message-days';
import { cn } from '@/lib/shadcn/utils';

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

const reasoningDuration = (timing: ThreadGroupPart['timing']) =>
  timing?.completedAt === undefined
    ? undefined
    : Math.round((timing.completedAt - timing.startedAt) / 1000);

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`. When `TaskGroup` is set, tool calls that carry a nested
 * conversation and have no registered UI render through it instead of the
 * tool group; without it they render like any other tool call.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  /** Replaces the default rendering of system messages (a muted, centered note). */
  SystemMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  /** Rendered in the viewport footer, right above the composer. */
  BeforeComposer?: ComponentType | undefined;
  /** Model effort menu, rendered beside the send button. */
  ComposerEffort?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
  ReasoningGroup?: ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
  TaskGroup?: ComponentType<{ group: ThreadGroupPart }> | undefined;
};

const messageGroupBy = groupPartByType({
  reasoning: ['group-chainOfThought', 'group-reasoning'],
  'tool-call': ['group-chainOfThought', 'group-tool'],
  'standalone-tool-call': [],
});

type ThreadGroupKey = 'group-chainOfThought' | 'group-reasoning' | 'group-tool' | 'group-task';

const TASK_GROUP_PATH: readonly ThreadGroupKey[] = ['group-chainOfThought', 'group-task'];

const taskAwareGroupBy = (
  part: Parameters<typeof messageGroupBy>[0],
  context?: Parameters<typeof messageGroupBy>[1]
): readonly ThreadGroupKey[] => {
  const path = messageGroupBy(part, context);
  return part.type === 'tool-call' &&
    part.messages !== undefined &&
    path.length > 0 &&
    !context?.toolUIs?.[part.toolName]?.length
    ? TASK_GROUP_PATH
    : path;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
  placeholder?: string | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext = createContext<ThreadComponents>(EMPTY_COMPONENTS);

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
  const { Welcome = ThreadWelcome, BeforeComposer } = useContext(ThreadComponentsContext);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [mascotEasterEgg, setMascotEasterEgg] = useState(false);
  // A new chat starts at the top, even when the previous conversation was
  // scrolled down. Keep this independent of mascot positioning.
  const threadId = useAuiState((s) => s.threadListItem.id);
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
      style={{
        ['--thread-max-width' as string]: '44rem',
        ['--composer-bg' as string]: 'var(--color-card)',
        ['--composer-radius' as string]: '1.5rem',
        ['--composer-padding' as string]: '10px',
      }}
    >
      <MascotEasterEggContext.Provider value={setMascotEasterEgg}>
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
              'relative mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4',
              // Optical centre sits above the geometric one: bias the block upward.
              isEmpty && 'justify-center pb-8 sm:pb-[20dvh]'
            )}
          >
            <AuiIf condition={isNewChatView}>
              <Welcome />
            </AuiIf>

            <ThreadLoadEarlier />

            <div data-slot="aui_message-group" className="mb-14 flex flex-col gap-y-6 empty:hidden">
              <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
            </div>

            <ThreadPrimitive.ViewportFooter
              className={cn(
                'aui-thread-viewport-footer flex flex-col gap-4 overflow-visible pb-4 md:pb-6',
                isEmpty && 'aui-thread-empty-footer',
                // The gap above the composer fades the messages out instead of cutting them off.
                !isEmpty &&
                  'sticky bottom-0 z-20 mt-auto bg-[linear-gradient(to_bottom,transparent,var(--color-background)_1.5rem)] pt-6'
              )}
            >
              <ThreadScrollToBottom />
              <ThreadFollowupSuggestions />
              {BeforeComposer && <BeforeComposer />}
              <Composer autoFocus={autoFocus} placeholder={placeholder} docked={!isEmpty} />
              <AuiIf condition={isNewChatView}>
                <ThreadSuggestions />
              </AuiIf>
            </ThreadPrimitive.ViewportFooter>
          </div>
        </ThreadPrimitive.Viewport>
        {/* One persistent mascot can travel between the chat and settings header. */}
        <Mascot viewportRef={viewportRef} easterEggEnabled={mascotEasterEgg} />
      </MascotEasterEggContext.Provider>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const {
    AssistantMessage: AssistantMessageComponent = AssistantMessage,
    SystemMessage: SystemMessageComponent = SystemMessage,
  } = useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);

  return (
    <>
      <MessageDayHeader />
      {isEditing ? (
        <EditComposer />
      ) : role === 'user' ? (
        <UserMessage />
      ) : role === 'system' ? (
        <SystemMessageComponent />
      ) : (
        <AssistantMessageComponent />
      )}
    </>
  );
};

/** Opens a new day: shown above a message dated on a later day than the one before it. */
const MessageDayHeader: FC = () => {
  const day = useAuiState((s) => {
    const here = s.message.createdAt;
    if (!here) return null;
    const previous = s.thread.messages[s.message.index - 1]?.createdAt;
    const key = dayKey(here);
    return previous && dayKey(previous) === key ? null : key;
  });
  if (!day) return null;
  return <DayHeader day={dayLabel(day)} className="-mb-2 px-2" />;
};

/** The message's time of day, revealed while its row is hovered. */
const MessageTime: FC<{ className?: string }> = ({ className }) => {
  const time = useAuiState((s) => (s.message.createdAt ? timeLabel(s.message.createdAt) : null));
  if (!time) return null;
  return (
    <span
      data-slot="aui_message-time"
      className={cn(
        mono,
        'text-foreground/0 group-hover/message:text-foreground/35 shrink-0 tabular-nums transition-colors',
        className
      )}
    >
      {time}
    </span>
  );
};

const SystemMessage: FC = () => (
  <MessagePrimitive.Root
    data-slot="aui_system-message-root"
    data-role="system"
    className="text-muted-foreground px-2 text-center text-xs"
  >
    <MessagePrimitive.Parts />
  </MessagePrimitive.Root>
);

const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']):not([disabled])";

const nextFocusable = (start: Element) => {
  for (let element = start.nextElementSibling; element; element = element.nextElementSibling) {
    const target = element.matches(FOCUSABLE_SELECTOR)
      ? element
      : element.querySelector(FOCUSABLE_SELECTOR);
    if (target instanceof HTMLElement) return target;
  }
  return null;
};

const ThreadLoadEarlier: FC = () => {
  const visible = useAuiState((s) => s.thread.hasEarlier || s.thread.isLoadingEarlier);
  const loading = useAuiState((s) => s.thread.isLoadingEarlier);
  const slotRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<Element | null>(null);

  // The last page removes the button; a keyboard user on it continues from the
  // next control in tab order rather than from the document body.
  useLayoutEffect(() => {
    const focused = focusedRef.current;
    const slot = slotRef.current;
    if (visible || !focused || focused.isConnected || !slot) return;
    focusedRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    nextFocusable(slot)?.focus();
  }, [visible]);

  return (
    <div
      ref={slotRef}
      className="contents"
      onFocus={(event) => {
        focusedRef.current = event.target;
      }}
    >
      <span role="status" className="sr-only">
        {loading ? 'Loading earlier messages' : ''}
      </span>
      {visible && (
        <ThreadPrimitive.LoadEarlier asChild>
          <Button
            variant="ghost"
            size="sm"
            data-slot="aui_thread-load-earlier"
            className="aui-thread-load-earlier text-muted-foreground mb-6 self-center rounded-full"
          >
            <span className={cn(loading && 'shimmer motion-reduce:animate-none')}>
              {loading ? 'Loading earlier messages' : 'Load earlier messages'}
            </span>
          </Button>
        </ThreadPrimitive.LoadEarlier>
      )}
    </div>
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom bouncy bg-foreground text-background hover:bg-foreground hover:text-background absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
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
  const composerEmpty = useAuiState((s) => s.composer.isEmpty);
  return (
    <div
      className={cn(
        'aui-thread-welcome-suggestions flex w-full flex-col transition-opacity duration-200',
        !composerEmpty && 'pointer-events-none opacity-0'
      )}
      aria-hidden={!composerEmpty}
    >
      <ThreadPrimitive.Suggestions>{() => <ThreadSuggestionItem />}</ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <button
          type="button"
          className="aui-thread-welcome-suggestion group hover:bg-foreground/[0.03] focus-visible:ring-ring/50 flex w-full items-baseline gap-2.5 rounded-md px-2 py-2 text-start text-sm transition-colors outline-none focus-visible:ring-1 motion-reduce:transition-none"
        >
          <span
            aria-hidden
            className="text-muted-foreground/60 group-hover:text-foreground font-mono text-xs transition-colors motion-reduce:transition-none"
          >
            {'>'}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 text-foreground" />{' '}
            <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-muted-foreground empty:hidden" />
          </span>
        </button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

// Last on-screen position of the composer. Module-level so it survives the
// thread remounting when a new chat becomes a conversation.
let lastComposerTop: number | null = null;

/**
 * The composer is one element that changes place: centred on a new chat,
 * docked at the bottom in a conversation. When it changes place it glides
 * from where it was (FLIP) instead of jumping.
 */
const useComposerGlide = (docked: boolean) => {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const from = lastComposerTop;
    lastComposerTop = top;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (from === null || reduceMotion || Math.abs(from - top) < 8) return;
    element.animate([{ transform: `translateY(${from - top}px)` }, { transform: 'none' }], {
      duration: 420,
      easing: 'cubic-bezier(0.25, 1.06, 0.4, 1)',
    });
  }, [docked]);
  // Keep the remembered position current as the composer grows or scrolls.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const remember = () => {
      if (element.getAnimations().length === 0) {
        lastComposerTop = element.getBoundingClientRect().top;
      }
    };
    const observer = new ResizeObserver(remember);
    observer.observe(element);
    window.addEventListener('resize', remember);
    return () => {
      remember();
      observer.disconnect();
      window.removeEventListener('resize', remember);
    };
  }, []);
  return ref;
};

const Composer: FC<{ autoFocus: boolean; placeholder: string; docked: boolean }> = ({
  autoFocus,
  placeholder,
  docked,
}) => {
  const glideRef = useComposerGlide(docked);
  return (
    <div ref={glideRef} className="aui-thread-composer w-full">
      <ComposerRoot autoFocus={autoFocus} placeholder={placeholder} />
    </div>
  );
};

const ComposerRoot: FC<{ autoFocus: boolean; placeholder: string }> = ({
  autoFocus,
  placeholder,
}) => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="aui_composer-shell"
          className="border-border focus-within:border-primary data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border-2 bg-(--composer-bg) p-(--composer-padding) transition-[border-color] duration-200 data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          <ComposerAttachments />
          <ComposerPrimitive.Input
            placeholder={placeholder}
            className="aui-composer-input caret-primary placeholder:text-muted-foreground/70 max-h-48 min-h-10 w-full resize-none bg-transparent px-3 py-1.5 text-base leading-6 outline-none"
            rows={1}
            autoFocus={autoFocus}
            enterKeyHint="send"
            spellCheck
            aria-label="Message input"
          />
          <ComposerAction />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  // The stop control only cancels the send while no run it could stop is going.
  const isSending = useAuiState(
    (s) =>
      s.composer.submission !== undefined && !(s.thread.isRunning && s.thread.capabilities.cancel)
  );
  const { ComposerEffort } = useContext(ThreadComponentsContext);
  const { callButton } = useChatThread();
  const recorder = useVoiceRecorder();
  const composerEmpty = useAuiState((s: AssistantState) => s.composer.isEmpty);
  const hasComposerAttachments = useAuiState(
    (s: AssistantState) => s.composer.attachments.length > 0
  );
  const canCancel = useAuiState((s: AssistantState) => s.composer.canCancel);
  const showCallButton = composerEmpty && !hasComposerAttachments && !canCancel;

  if (recorder.status !== 'idle') return <ComposerVoice recorder={recorder} />;

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex min-w-0 items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.attachments}>
          <ComposerAddAttachment />
        </AuiIf>
      </div>
      <div className="ms-auto flex items-center gap-1.5">
        {ComposerEffort && <ComposerEffort />}
        <ComposerVoiceButton recorder={recorder} />
        {showCallButton ? (
          <TooltipIconButton
            tooltip={callButton.tooltip}
            side="top"
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-call bouncy size-6 rounded-full sm:size-8"
            aria-label={callButton.tooltip}
            disabled={callButton.disabled || hasComposerAttachments}
            onClick={callButton.onClick}
          >
            {callButton.active ? (
              <PhoneOffIcon className="size-4" />
            ) : (
              <AudioLinesIcon className="size-4" />
            )}
          </TooltipIconButton>
        ) : (
          <AuiIf
            condition={(s) =>
              !s.composer.canCancel ||
              (s.thread.voice !== undefined && s.composer.submission === undefined)
            }
          >
            <ComposerPrimitive.Send asChild>
              <TooltipIconButton
                tooltip="Send message"
                side="bottom"
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-send bouncy size-6 rounded-full sm:size-8"
                aria-label="Send message"
              >
                <ArrowUpIcon className="aui-composer-send-icon size-3 sm:size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Send>
          </AuiIf>
        )}
        <AuiIf
          condition={(s) =>
            s.composer.canCancel &&
            (s.thread.voice === undefined || s.composer.submission !== undefined)
          }
        >
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-7 rounded-full"
              aria-label={isSending ? 'Cancel sending' : 'Stop generating'}
            >
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root bg-destructive mt-2 rounded-2xl px-4 py-3 text-sm font-bold text-white">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

/** A reply the user stopped: what arrived before the stop stays, with a note under it. */
const StoppedNotice: FC = () => {
  const stopped = useAuiState(
    (s) =>
      s.message.role === 'assistant' &&
      s.message.status?.type === 'incomplete' &&
      s.message.status.reason === 'cancelled'
  );
  if (!stopped) return null;
  return (
    <span
      data-slot="aui_stopped-notice"
      className={cn(
        field,
        mono,
        'text-muted-foreground animate-in fade-in mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 duration-200 first:mt-0'
      )}
    >
      <SquareIcon className="size-2.5 fill-current" aria-hidden />
      stopped by you
    </span>
  );
};

/** The tool calls of a group, as displays read them. */
function groupCalls(
  parts: readonly { type: string; toolName?: string; argsText?: string }[],
  group: ThreadGroupPart
): ToolCall[] {
  return group.indices.flatMap((index) => {
    const part = parts[index];
    return part?.type === 'tool-call' && part.toolName
      ? [toolCall(part.toolName, part.argsText)]
      : [];
  });
}

/** Group dropdown that adopts the display its calls share (see `tool-display.ts`). */
const ToolCallGroup: FC<PropsWithChildren<{ group: ThreadGroupPart }>> = ({ group, children }) => {
  // Displays are module constants and labels strings: the selections only
  // change when the group's display or label does.
  const display = useAuiState((s) => getToolGroupDisplay(groupCalls(s.message.parts, group)));
  const label = useAuiState((s) => getToolGroupLabel(groupCalls(s.message.parts, group)));

  return (
    <ToolGroupRoot variant="ghost">
      <ToolGroupTrigger
        active={group.status.type === 'running'}
        icon={display.icon}
        label={label}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    TaskGroup: TaskGroupComponent,
  } = useContext(ThreadComponentsContext);
  const groupBy = TaskGroupComponent ? taskAwareGroupBy : messageGroupBy;

  const ACTION_BAR_PT = 'pt-1.5';
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="group/message animate-rise-in relative -mb-7.5 pb-7.5"
    >
      <div
        data-slot="aui_assistant-message-content"
        data-mascot-message=""
        className="peer/content text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts groupBy={groupBy}>
          {({ part, children }) => {
            switch (part.type) {
              case 'group-chainOfThought':
                return (
                  <div data-slot="aui_chain-of-thought" className="mb-1.5 last:mb-0">
                    {children}
                  </div>
                );
              case 'group-task':
                return TaskGroupComponent ? <TaskGroupComponent group={part} /> : null;
              case 'group-tool':
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                // A lone tool call renders inline; collapsing a single item adds a click for nothing.
                if (part.indices.length === 1) {
                  return children;
                }
                return <ToolCallGroup group={part}>{children}</ToolCallGroup>;
              case 'group-reasoning': {
                if (ReasoningGroup) {
                  return <ReasoningGroup group={part}>{children}</ReasoningGroup>;
                }
                const running = part.status.type === 'running';
                return (
                  <ReasoningRoot
                    variant="ghost"
                    className="mb-0"
                    streaming={running}
                    expandWhileStreaming={false}
                  >
                    <ReasoningTrigger active={running} duration={reasoningDuration(part.timing)} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case 'text':
                return <MarkdownText />;
              case 'reasoning':
                return <Reasoning {...part} />;
              case 'tool-call':
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case 'data':
                return part.dataRendererUI;
              case 'file':
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <File {...part} />
                  </div>
                );
              case 'image':
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              case 'indicator':
                return (
                  // An empty box where the reply will start: the mascot waits here.
                  <span
                    data-slot="aui_assistant-message-indicator"
                    data-mascot-anchor="waiting"
                    role="status"
                    aria-label="Assistant is working"
                    className="inline-block h-7 w-6 align-middle"
                  />
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
        <StoppedNotice />
      </div>
      <MessageLinkPreviews />

      {/* When the mascot drops below the reply, the actions sit beside it. */}
      <div
        data-slot="aui_assistant-message-footer"
        className={cn(
          'ms-2 flex items-center transition-[margin] duration-200 peer-data-[mascot-wrapped]/content:ms-12',
          ACTION_BAR_HEIGHT
        )}
      >
        <BranchPicker />
        <AssistantActionBar />
        <MessageTime className="ms-1.5" />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <AuiIf condition={(s) => s.thread.capabilities.feedback}>
        <ActionBarPrimitive.FeedbackPositive asChild>
          <TooltipIconButton
            tooltip="Helpful"
            className="data-[submitted=true]:bg-accent data-[submitted=true]:text-accent-foreground"
          >
            <ThumbsUpIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.FeedbackPositive>
        <ActionBarPrimitive.FeedbackNegative asChild>
          <TooltipIconButton
            tooltip="Not helpful"
            className="data-[submitted=true]:bg-accent data-[submitted=true]:text-accent-foreground"
          >
            <ThumbsDownIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.FeedbackNegative>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.capabilities.reload}>
        <ActionBarPrimitive.Reload asChild>
          <TooltipIconButton tooltip="Refresh">
            <RefreshCwIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.Reload>
      </AuiIf>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton tooltip="More" className="data-[state=open]:bg-accent">
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content mobile-menu-motion bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

const UserMessage: FC = () => {
  const isSpoken = useAuiState((s) => s.message.metadata.modality === 'voice');
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="group/message animate-pop-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div
          className={cn(
            'aui-user-message-content peer bg-bubble text-primary-foreground rounded-[1.5rem] rounded-br-lg px-5 py-3 text-[15px] leading-relaxed font-semibold wrap-break-word empty:hidden',
            isSpoken && 'italic'
          )}
        >
          {isSpoken ? (
            <div className="flex items-start gap-2">
              {/* Centered on the first line of text. */}
              <PhoneIcon
                aria-label="Said in a call"
                className="mt-[calc((1lh-0.875rem)/2)] size-3.5 shrink-0 opacity-70"
              />
              <div className="min-w-0">
                <MessagePrimitive.Parts components={{ File: UserFilePart, Image: UserImagePart }} />
              </div>
            </div>
          ) : (
            <MessagePrimitive.Parts components={{ File: UserFilePart, Image: UserImagePart }} />
          )}
        </div>
      </div>

      <div
        data-slot="aui_user-message-footer"
        className="col-span-full col-start-1 -mt-1 flex min-h-7 items-center justify-end gap-1"
      >
        <MessageTime className="me-1.5" />
        <BranchPicker data-slot="aui_user-branch-picker" className="-me-1" />
        <UserActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  const aui = useAui();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root text-muted-foreground animate-in fade-in -me-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <AuiIf condition={(s) => s.thread.capabilities.edit}>
        <ActionBarPrimitive.Edit asChild>
          <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
            <PencilIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.Edit>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.capabilities.delete}>
        <ActionBarMorePrimitive.Root>
          <ActionBarMorePrimitive.Trigger asChild>
            <TooltipIconButton tooltip="More" className="data-[state=open]:bg-accent">
              <MoreHorizontalIcon />
            </TooltipIconButton>
          </ActionBarMorePrimitive.Trigger>
          <ActionBarMorePrimitive.Content
            side="bottom"
            align="end"
            sideOffset={6}
            className="aui-action-bar-more-content mobile-menu-motion bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
          >
            <ActionBarMorePrimitive.Item
              onSelect={() => void aui.message.delete()}
              className="aui-action-bar-more-item text-destructive hover:bg-destructive/10 focus:bg-destructive/10 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
            >
              <TrashIcon className="size-4" />
              Delete
            </ActionBarMorePrimitive.Item>
          </ActionBarMorePrimitive.Content>
        </ActionBarMorePrimitive.Root>
      </AuiIf>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root data-slot="aui_edit-composer-wrapper" className="flex flex-col px-2">
      <ComposerPrimitive.Root className="aui-edit-composer-root border-foreground/10 focus-within:border-foreground/25 ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg) transition-[border-color]">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 px-3">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

// Only shown when the runtime can switch branches: an external store that
// replaces live messages with persisted ones can leave stale siblings behind.
const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = (props) => (
  <AuiIf condition={(s) => s.thread.capabilities.switchToBranch}>
    <BranchPickerImpl {...props} />
  </AuiIf>
);

const BranchPickerImpl: FC<BranchPickerPrimitive.Root.Props> = ({ className, ...rest }) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        'aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs',
        className
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
