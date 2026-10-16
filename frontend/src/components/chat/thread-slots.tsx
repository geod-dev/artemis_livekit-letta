import { type CSSProperties, createContext, useContext, useEffect, useRef, useState } from 'react';
import { ArrowUpRightIcon, BrainIcon, XIcon } from 'lucide-react';
import { Popover } from 'radix-ui';
import {
  ComposerPrimitive,
  MessagePrimitive,
  QueueItemPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import type { ConversationContextUsage, ConversationSummary, TextEffort } from '@shared/chat-types';
import type { ThreadComponents } from '@/components/assistant-ui/chat/thread';
import { IconButton } from '@/components/assistant-ui/shared/icon-button';
import { type ActivityTask, taskTitle, useActivity } from '@/components/chat/activity-context';
import { TaskStopButton } from '@/components/chat/workspace-panel';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { TaskStatus } from '@/hooks/use-conversation';
import type { VoiceRecorderStatus } from '@/hooks/use-voice-recorder';
import { stripLeadingEmoji } from '@/lib/agent-runs';
import { greetingsFor, pickGreeting } from '@/lib/greetings';
import { cn } from '@/lib/shadcn/utils';
import { formatTaskDuration, taskStatusLabel, workedFor } from '@/lib/task-status';

/** App state the thread slots need but assistant-ui does not track. */
export interface ChatThreadState {
  assistantName: string;
  contextUsage: ConversationContextUsage | null;
  effort: TextEffort;
  setEffort: (effort: TextEffort) => void;
  callButton: {
    label: string;
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
  recentConversation: ConversationSummary | null;
  resumeConversation: (id: string) => void;
  conversationStats: { total: number; activeThisWeek: number } | null;
}

export const ChatThreadContext = createContext<ChatThreadState | null>(null);
export const MascotEasterEggContext = createContext<(enabled: boolean) => void>(() => {});
export const MascotRecordingContext = createContext<(status: VoiceRecorderStatus) => void>(
  () => {}
);

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
    <div className="artemis-welcome">
      {/* The thread's mascot settles into this box. */}
      <div className="welcome-character">
        <span className="character-orbit" aria-hidden="true" />
        <span data-mascot-anchor="welcome" className="welcome-mascot-anchor" />
      </div>
      <h2
        key={greeting ?? 'pending'}
        onDoubleClick={chooseAnotherGreeting}
        className={cn(
          'aui-welcome-title font-display max-w-full text-balance select-none',
          greeting ? 'animate-pop-in [animation-delay:90ms]' : 'invisible'
        )}
      >
        {greeting ?? 'Hello'}
      </h2>
    </div>
  );
}

export function WelcomeStats() {
  const { conversationStats } = useChatThread();
  return (
    <>
      {conversationStats && (
        <dl className="welcome-stats" aria-label="Conversation activity">
          <div>
            <dt>Conversations</dt>
            <dd>{conversationStats.total.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Active this week</dt>
            <dd>{conversationStats.activeThisWeek.toLocaleString()}</dd>
          </div>
        </dl>
      )}
    </>
  );
}

export function WelcomeContinuation({ tabIndex = 0 }: { tabIndex?: number }) {
  const { recentConversation, resumeConversation } = useChatThread();
  return (
    <>
      {recentConversation && (
        <button
          type="button"
          tabIndex={tabIndex}
          className="welcome-resume"
          onClick={() => resumeConversation(recentConversation.id)}
        >
          <span className="resume-label">Continue</span>
          <span className="resume-title">
            {recentConversation.title || 'Untitled conversation'}
          </span>
          {recentConversation.updatedAt &&
            Number.isFinite(Date.parse(recentConversation.updatedAt)) && (
              <time dateTime={recentConversation.updatedAt}>
                {new Date(recentConversation.updatedAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </time>
            )}
          <ArrowUpRightIcon aria-hidden="true" />
        </button>
      )}
    </>
  );
}

const EFFORT_VALUES: TextEffort[] = ['low', 'medium', 'high'];
const EFFORT_LABELS: Record<TextEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

function ComposerEffortControl() {
  const { effort, setEffort } = useChatThread();
  const index = EFFORT_VALUES.indexOf(effort);
  const particleCount = [14, 16, 18][index];
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [particleStyles] = useState(() =>
    Array.from({ length: 18 }, () => {
      const random = (min: number, max: number) => min + Math.random() * (max - min);
      return {
        size: random(1.5, 4.5),
        yStart: random(-12, 12),
        yEnd: random(-12, 12),
        speedFactor: random(0.75, 1.25),
        phase: random(-1, 0),
        opacity: random(0.35, 0.95),
      };
    })
  );

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => {
      setIsMobile(query.matches);
      setMobileOpen(false);
      setDesktopOpen(false);
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const pickerContent = (
    <>
      <p className="mb-3 text-center text-sm font-bold">{EFFORT_LABELS[effort]}</p>
      <div
        className="effort-slider-wrap relative flex h-[68px] items-center"
        style={
          {
            '--effort-progress': `${(index / (EFFORT_VALUES.length - 1)) * 100}%`,
          } as CSSProperties
        }
      >
        <div className="effort-slider-track" aria-hidden="true">
          <span className="effort-slider-fill">
            {particleStyles.slice(0, particleCount).map((style, particleIndex) => (
              <i
                key={particleIndex}
                className="effort-slider-particle"
                style={
                  {
                    '--particle-size': `${style.size}px`,
                    '--particle-y-start': `${style.yStart}px`,
                    '--particle-y-end': `${style.yEnd}px`,
                    '--particle-duration': `${950 * style.speedFactor}ms`,
                    '--particle-delay': `${950 * style.phase}ms`,
                    '--particle-opacity': style.opacity,
                  } as CSSProperties
                }
              />
            ))}
          </span>
          <span className="effort-slider-thumb" />
        </div>
        <input
          type="range"
          min={0}
          max={EFFORT_VALUES.length - 1}
          step={1}
          value={index}
          onChange={(event) =>
            setEffort(EFFORT_VALUES[Number(event.target.value)])
          }
          aria-label="Text response effort"
          aria-valuetext={EFFORT_LABELS[effort]}
          className="effort-slider absolute inset-0 z-10 h-full w-full cursor-pointer"
        />
      </div>
    </>
  );

  return (
    <>
      <Popover.Root open={!isMobile && desktopOpen} onOpenChange={setDesktopOpen}>
        <Popover.Anchor asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title={`Response effort: ${EFFORT_LABELS[effort]}`}
            aria-haspopup="dialog"
            aria-expanded={isMobile ? mobileOpen : desktopOpen}
            onClick={() => {
              if (isMobile) setMobileOpen(true);
              else setDesktopOpen((open) => !open);
            }}
            className="aui-composer-effort-trigger text-muted-foreground hover:bg-muted hover:text-foreground h-7 rounded-full bg-transparent px-2.5 text-xs font-semibold"
          >
            {EFFORT_LABELS[effort]}
          </Button>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="end"
            sideOffset={10}
            className="surface-panel effort-popover text-popover-foreground z-50 w-72 p-3 outline-none"
          >
            {pickerContent}
            <Popover.Arrow className="effort-popover-arrow" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent
          showCloseButton={false}
          aria-label="Response effort"
          className="effort-mobile-dialog gap-2 p-5"
        >
          {pickerContent}
        </DialogContent>
      </Dialog>
    </>
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
    taskId?: string;
    status?: 'completed' | 'failed' | 'cancelled';
    durationMs?: number;
    detail?: string;
    unread?: boolean;
  };
  const ref = useReadWhenSeen(custom.updateId, custom.unread === true);
  const { tasks, openTask } = useActivity();
  const text = useAuiState((s) =>
    s.message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
  );
  const recordedTask = tasks.find(
    (t) =>
      (custom.updateId && t.updateId === custom.updateId) ||
      (custom.taskId && t.id === custom.taskId)
  );
  const task: ActivityTask = {
    ...recordedTask,
    id: recordedTask?.id ?? custom.taskId ?? custom.updateId ?? text,
    title: recordedTask?.agentTitle ?? recordedTask?.title ?? text,
    status: custom.status ?? recordedTask?.status ?? 'completed',
    report: custom.detail ?? recordedTask?.report,
    durationMs: custom.durationMs ?? recordedTask?.durationMs,
  };
  return (
    <MessagePrimitive.Root data-role="system" className="flex w-full flex-col items-start px-2">
      <div ref={ref} className="text-muted-foreground flex max-w-full items-center gap-2 text-sm">
        {custom.kind === 'memory' ? (
          <>
            <BrainIcon aria-hidden className="size-4 shrink-0 text-violet-500" />
            <span>
              <MessagePrimitive.Parts />
            </span>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => openTask(task)}
              className="text-muted-foreground hover:text-foreground focus-visible:outline-ring min-w-0 cursor-pointer rounded-md py-1 text-left transition-colors focus-visible:outline-2"
            >
              <span>{taskTitle(task)}</span>
              <span className="text-muted-foreground/60">
                {' '}
                - {workedFor(task.durationMs)}
                {recordedTask?.rerunName
                  ? ' (' + stripLeadingEmoji(recordedTask.rerunName) + ')'
                  : ''}
                {task.status === 'failed' || task.status === 'cancelled'
                  ? ' · ' + taskStatusLabel({ status: task.status })
                  : ''}
              </span>
            </button>
          </>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

/** Running background tasks, the last turn's error, and queued messages. */
function BeforeComposer() {
  const { error } = useChatThread();
  const { tasks: allTasks, openTask, error: activityError } = useActivity();
  const tasks = allTasks.filter((task) => task.status === 'running');
  const queued = useAuiState((s) => s.composer.queue.length);
  if (tasks.length === 0 && !error && !activityError && queued === 0) return null;

  return (
    <div className="flex max-h-48 w-full flex-col items-start gap-1 overflow-y-auto px-1 text-xs">
      {tasks.map((t) => (
        <div
          key={t.id}
          className="group text-muted-foreground flex w-full items-center gap-2 text-sm"
        >
          <button
            type="button"
            onClick={() => openTask(t)}
            className="hover:text-foreground focus-visible:outline-ring flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-left focus-visible:outline-2"
          >
            <span className="truncate">{taskTitle({ ...t, title: t.agentTitle ?? t.title })}</span>
            <span className="shrink-0 text-xs">
              - Running - {formatTaskDuration(t.durationMs) ?? '0s'}
            </span>
          </button>
          <TaskStopButton
            task={t}
            className="size-8 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          />
        </div>
      ))}
      {error && <p className="task-error animate-pop-in rounded-xl px-4 py-2 text-sm">{error}</p>}
      {activityError && (
        <p role="alert" className="text-destructive px-1 py-2 text-sm">
          {activityError}
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
              <IconButton label="Remove from queue" className="size-6 rounded-full">
                <XIcon className="size-3.5" />
              </IconButton>
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
