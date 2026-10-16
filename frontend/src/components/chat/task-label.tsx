import { TerminalIcon } from 'lucide-react';
import { type ActivityTask, taskTitle } from './activity-context';

export function TaskLabel({ task }: { task: Pick<ActivityTask, 'title' | 'kind'> }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 align-bottom">
      {task.kind === 'command' && <TerminalIcon aria-hidden className="size-4 shrink-0" />}
      <span className="truncate">{taskTitle(task)}</span>
    </span>
  );
}
