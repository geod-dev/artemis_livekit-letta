import { Loader2Icon, SquareIcon } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useAppActivity } from '@/hooks/use-app-activity';
import type { AgentRun } from '@/lib/agent-runs';

/** Stops a running task, or every running run of a grouped task. */
export function TaskStopButton({
  task,
  className,
  showSpinner = false,
}: {
  task: AgentRun & { runs?: AgentRun[] };
  className?: string;
  showSpinner?: boolean;
}) {
  const { stopTask, stopping } = useAppActivity();
  if (task.status !== 'running' || task.id.startsWith('launch:')) return null;
  const running = task.runs?.filter((run) => run.status === 'running') ?? [task];
  const pending = running.some((run) => stopping.has(run.id));
  return (
    <IconButton
      label={pending ? 'Stopping task' : 'Stop task'}
      disabled={pending}
      onClick={() => void Promise.all(running.map((run) => stopTask(run.id)))}
      className={className}
    >
      {pending ? (
        <Loader2Icon aria-hidden className="size-4 animate-spin" />
      ) : showSpinner ? (
        <>
          <Loader2Icon
            aria-hidden
            className="text-muted-foreground size-4 animate-spin group-focus-within:hidden group-hover:hidden [@media(hover:none)]:hidden"
          />
          <SquareIcon
            aria-hidden
            fill="currentColor"
            strokeWidth={0}
            className="hidden size-3.5 group-focus-within:block group-hover:block [@media(hover:none)]:block"
          />
        </>
      ) : (
        <SquareIcon aria-hidden fill="currentColor" strokeWidth={0} className="size-3.5" />
      )}
    </IconButton>
  );
}
