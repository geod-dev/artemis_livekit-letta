import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { BrainIcon, PartyPopperIcon, XIcon } from 'lucide-react';
import { Popover } from 'radix-ui';
import { Streamdown } from 'streamdown';
import {
  ComposerPrimitive,
  MessagePrimitive,
  QueueItemPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import type { TextEffort } from '@backend/chat-types';
import {
  MARKDOWN_COMPONENTS,
  MARKDOWN_REHYPE_PLUGINS,
} from '@/components/assistant-ui/elements/markdown-text';
import type { ThreadComponents } from '@/components/assistant-ui/elements/thread.aui';
import { TooltipIconButton } from '@/components/assistant-ui/elements/tooltip-icon-button';
import { Button } from '@/components/ui/button';
import type { TaskStatus } from '@/hooks/use-conversation';
import { greetingsFor, pickGreeting } from '@/lib/greetings';
import { cn } from '@/lib/shadcn/utils';

/** App state the thread slots need but assistant-ui does not track. */
export interface ChatThreadState {
  assistantName: string;
  effort: TextEffort;
  setEffort: (effort: TextEffort) => void;
  /** The conversation has attachments: Instant (the fast model) is unavailable. */
  withAttachments: boolean;
  callButton: {
    tooltip: string;
    disabled: boolean;
    active: boolean;
    onClick: () => void;
  };
  /** A turn is running in this conversation (text or voice). */
  busy: boolean;
  tasks: TaskStatus[];
  error: string | null;
  /** Acknowledge background updates the user has seen. */
  markRead: (updateIds: string[]) => void;
}

export const ChatThreadContext = createContext<ChatThreadState | null>(null);
export const MascotEasterEggContext = createContext<(enabled: boolean) => void>(() => {});

export function useChatThread() {
  const state = useContext(ChatThreadContext);
  if (!state) throw new Error('ChatThreadContext is missing');
  return state;
}

/**
 * New chat: the assistant says hello with one big line, a fresh one each time.
 * Picked after mount (it depends on the clock and randomness), with the space
 * reserved so nothing moves when it appears.
 */
function Welcome() {
  const { assistantName } = useChatThread();
  const setMascotEasterEgg = useContext(MascotEasterEggContext);
  const [greeting, setGreeting] = useState<string | null>(null);
  const chooseAnotherGreeting = () => {
    const choices = greetingsFor(new Date().getHours(), assistantName).filter(
      (line) => line !== greeting
    );
    const next = choices[Math.floor(Math.random() * choices.length)] ?? greeting ?? 'Hello';
    setGreeting(next);
    setMascotEasterEgg(next === 'Hit me.');
  };
  useEffect(() => {
    const next = pickGreeting(assistantName);
    setGreeting(next);
    setMascotEasterEgg(next === 'Hit me.');
    return () => setMascotEasterEgg(false);
  }, [assistantName, setMascotEasterEgg]);

  return (
    <div className="mb-8 flex flex-col items-center gap-6 px-2 text-center">
      {/* The thread's mascot settles into this box. */}
      <span data-mascot-anchor="welcome" className="block size-20" />
      <h2
        key={greeting ?? 'pending'}
        onDoubleClick={chooseAnotherGreeting}
        className={cn(
          'font-display max-w-full text-[clamp(1.75rem,6.5vw,3rem)] leading-[1.05] font-extrabold tracking-tight text-balance select-none',
          greeting ? 'animate-pop-in [animation-delay:90ms]' : 'invisible'
        )}
      >
        {greeting ?? 'Hello'}
      </h2>
    </div>
  );
}

const EFFORT_VALUES: TextEffort[] = ['fast', 'low', 'medium', 'high'];
const EFFORT_LABELS: Record<TextEffort, string> = {
  fast: 'Instant',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

function ComposerEffortControl() {
  const { effort: chosen, setEffort, withAttachments } = useChatThread();
  const composerAttachments = useAuiState((s) => s.composer.attachments.length > 0);
  // The fast model reads no images: with attachments, Instant runs as Low.
  const locked = withAttachments || composerAttachments;
  const effort = locked && chosen === 'fast' ? 'low' : chosen;
  const index = EFFORT_VALUES.indexOf(effort);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Response effort: ${EFFORT_LABELS[effort]}`}
          title={`Response effort: ${EFFORT_LABELS[effort]}`}
          className="text-muted-foreground hover:bg-muted hover:text-foreground h-7 rounded-full px-2.5 text-xs font-semibold"
        >
          {EFFORT_LABELS[effort]}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={10}
          className="bg-popover text-popover-foreground z-50 w-60 rounded-2xl border p-4 shadow-lg outline-none"
        >
          <p className="mb-3 text-sm font-bold">Response effort</p>
          <div className="text-muted-foreground mb-1 flex justify-between text-[10px] whitespace-nowrap">
            <span
              className={cn(
                effort === 'fast' && 'text-primary font-semibold',
                locked && 'line-through opacity-50'
              )}
            >
              Instant
            </span>
            <span className={cn(effort === 'low' && 'text-primary font-semibold')}>Low</span>
            <span className={cn(effort === 'medium' && 'text-primary font-semibold')}>Medium</span>
            <span className={cn(effort === 'high' && 'text-primary font-semibold')}>High</span>
          </div>
          <input
            type="range"
            min={0}
            max={3}
            step={1}
            value={index}
            onChange={(event) =>
              setEffort(EFFORT_VALUES[Math.max(locked ? 1 : 0, Number(event.target.value))])
            }
            aria-label="Text response effort"
            aria-valuetext={EFFORT_LABELS[effort]}
            className="accent-primary h-5 w-full cursor-pointer"
          />
          {locked && (
            <p className="text-muted-foreground mt-2 text-xs">
              Can't use Instant with attachments.
            </p>
          )}
          <Popover.Arrow className="fill-popover" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** How long an unread result must stay on screen, in a focused window, to count as read. */
const READ_AFTER_MS = 1500;

/**
 * Mark a background result read once it has been visible on screen while the
 * window has focus. Receiving it over the network alone never does.
 */
function useReadWhenSeen(updateId: string | undefined, unread: boolean) {
  const { markRead } = useChatThread();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !updateId || !unread) return;
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      if (visible && document.visibilityState === 'visible' && document.hasFocus()) {
        timer = setTimeout(() => markRead([updateId]), READ_AFTER_MS);
      }
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        check();
      },
      { threshold: 0.6 }
    );
    observer.observe(element);
    window.addEventListener('focus', check);
    window.addEventListener('blur', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener('focus', check);
      window.removeEventListener('blur', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [markRead, unread, updateId]);
  return ref;
}

/** Background task results and memory updates, as small notes between turns. */
function SystemMessage() {
  const custom = useAuiState((s) => s.message.metadata.custom) as {
    kind?: string;
    updateId?: string;
    detail?: string;
    unread?: boolean;
  };
  const unread = custom.unread === true;
  const ref = useReadWhenSeen(custom.updateId, unread);
  const [open, setOpen] = useState(false);
  const Icon = custom.kind === 'memory' ? BrainIcon : PartyPopperIcon;
  return (
    <MessagePrimitive.Root data-role="system" className="flex flex-col items-center gap-2 px-2">
      <div
        ref={ref}
        className="bg-pink animate-pop-in inline-flex max-w-full items-center gap-2 rounded-full px-4 py-2 text-sm font-bold text-white"
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0">
          <MessagePrimitive.Parts />
        </span>
        {unread && (
          <span className="text-pink rounded-full bg-white px-2 py-0.5 text-[10px] font-extrabold uppercase">
            New
          </span>
        )}
        {custom.detail && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="rounded-full px-1 text-xs underline-offset-2 hover:underline"
          >
            {open ? 'Hide report' : 'Report'}
          </button>
        )}
      </div>
      {custom.detail && open && (
        <div className="bg-muted/60 w-full max-w-2xl rounded-2xl px-5 py-4 text-sm">
          <Streamdown components={MARKDOWN_COMPONENTS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS}>
            {custom.detail}
          </Streamdown>
        </div>
      )}
    </MessagePrimitive.Root>
  );
}

/** Running background tasks, the last turn's error, and queued messages. */
function BeforeComposer() {
  const { tasks, error } = useChatThread();
  const queued = useAuiState((s) => s.composer.queue.length);
  if (tasks.length === 0 && !error && queued === 0) return null;

  return (
    <div className="flex flex-col items-start gap-2 px-1 text-xs">
      {tasks.map((t) => (
        <div
          key={t.id}
          className="bg-sky animate-pop-in inline-flex max-w-full items-center gap-2 rounded-full px-4 py-2 text-sm font-bold text-white"
        >
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-white" />
          <span className="truncate">Working on it in the background: {t.title}</span>
        </div>
      ))}
      {error && (
        <p className="bg-destructive animate-pop-in rounded-2xl px-4 py-2 text-sm font-bold text-white">
          {error}
        </p>
      )}
      <ComposerPrimitive.Queue>
        {({ queueItem }) => (
          <div
            key={queueItem.id}
            className={cn(
              'bg-secondary text-muted-foreground animate-pop-in flex w-full items-center gap-2 rounded-full py-1 ps-4 pe-1 text-sm font-semibold'
            )}
          >
            <span className="text-foreground min-w-0 flex-1 truncate">
              <QueueItemPrimitive.Text />
            </span>
            <span className="shrink-0">sends when I’m done</span>
            <QueueItemPrimitive.Remove asChild>
              <TooltipIconButton tooltip="Remove from queue" className="size-6 rounded-full">
                <XIcon className="size-3.5" />
              </TooltipIconButton>
            </QueueItemPrimitive.Remove>
          </div>
        )}
      </ComposerPrimitive.Queue>
    </div>
  );
}

export const THREAD_COMPONENTS: ThreadComponents = {
  Welcome,
  SystemMessage,
  ComposerEffort: ComposerEffortControl,
  BeforeComposer,
};
