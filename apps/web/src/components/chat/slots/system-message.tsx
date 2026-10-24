import { useEffect, useRef } from 'react';
import { MessagePrimitive, useAuiState } from '@assistant-ui/react';
import { useActivity, useChatThread } from '@/components/chat/context';
import { TaskLabel } from '@/components/tasks/task-label';
import { type AgentRun, stripLeadingEmoji } from '@/lib/agent-runs';
import { taskDurationLabel, taskStatusLabel } from '@/lib/task-status';

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
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
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

/** Background task results, as small notes between turns. */
export function SystemMessage() {
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
  const task: AgentRun = {
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
        <button
          type="button"
          onClick={() => openTask(task)}
          className="text-muted-foreground hover:text-foreground focus-visible:outline-ring min-w-0 cursor-pointer rounded-md py-1 text-left transition-colors focus-visible:outline-2"
        >
          <TaskLabel task={task} />
          <span className="text-muted-foreground/60">
            {' '}
            - {taskDurationLabel(task.durationMs, task.kind)}
            {recordedTask?.rerunName ? ' (' + stripLeadingEmoji(recordedTask.rerunName) + ')' : ''}
            {task.status === 'failed' || task.status === 'cancelled'
              ? ' · ' + taskStatusLabel({ status: task.status })
              : ''}
          </span>
        </button>
      </div>
    </MessagePrimitive.Root>
  );
}
