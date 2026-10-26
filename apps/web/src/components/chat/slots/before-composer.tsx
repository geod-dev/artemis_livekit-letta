import { XIcon } from 'lucide-react';
import { ComposerPrimitive, QueueItemPrimitive, useAuiState } from '@assistant-ui/react';
import { TaskLabel } from '@/components/tasks/task-label';
import { TaskStopButton } from '@/components/tasks/task-stop-button';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useAppActivity } from '@/hooks/use-app-activity';
import { useChatThread } from '@/hooks/use-chat-thread';
import { reconnectLiveUpdates } from '@/lib/conversation-client';
import { LIVE_UPDATES_DOWN } from '@/lib/conversation-subscription';
import { cn } from '@/lib/shadcn/utils';
import { formatTaskDuration, taskStatusLabel } from '@/lib/task-status';

/** Running background tasks, the last turn's error, and queued messages. */
export function BeforeComposer() {
  const { error } = useChatThread();
  const { tasks: allTasks, openTask, error: activityError } = useAppActivity();
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
            <TaskLabel task={{ ...t, title: t.agentTitle ?? t.title }} />
            <span className="shrink-0 text-xs">
              - {taskStatusLabel(t)} - {formatTaskDuration(t.durationMs) ?? '0s'}
            </span>
          </button>
          <TaskStopButton
            task={t}
            className="size-8 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          />
        </div>
      ))}
      {error === LIVE_UPDATES_DOWN ? (
        <div className="task-error animate-pop-in flex w-full flex-wrap items-center gap-2 rounded-xl px-4 py-2 text-sm">
          <p className="min-w-0 flex-1">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={reconnectLiveUpdates}>
            Reconnect
          </Button>
        </div>
      ) : (
        error && <p className="task-error animate-pop-in rounded-xl px-4 py-2 text-sm">{error}</p>
      )}
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
