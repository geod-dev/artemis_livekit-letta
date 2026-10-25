import { Loader2Icon } from 'lucide-react';
import { MarkdownDocument } from '@/components/media/markdown/markdown-text';
import { TaskBubble } from '@/components/tasks/task-bubble';
import { TaskLabel } from '@/components/tasks/task-label';
import { taskTitle } from '@/components/tasks/task-title';
import { commandOutput, groupAgentRuns } from '@/lib/agent-runs';
import { formatTaskDuration, taskDurationLabel, taskStatusLabel } from '@/lib/task-status';

/** The runs of one task: each run's prompt or command, its output or report, and its state. */
export type TaskGroup = ReturnType<typeof groupAgentRuns>[number];

export function WorkspaceTaskDetail({ task }: { task: TaskGroup }) {
  return (
    <div className="space-y-8 p-5">
      {task.runs.map((run, index) => {
        const command = run.kind === 'command' ? commandOutput(run) : null;
        return (
          <section key={run.id} className="space-y-3">
            {index > 0 && (
              <h3 className="text-sm font-medium">
                <TaskLabel task={{ ...run, title: run.rerunName ?? run.title }} />
              </h3>
            )}
            <TaskBubble
              description={run.kind === 'command' ? taskTitle(run) : (run.rerunName ?? run.title)}
              prefix={command ? '$ ' : ''}
              text={command ? command.command : run.prompt}
            />
            <p className="text-muted-foreground/60 flex items-center gap-2 text-xs">
              {run.status === 'running' && (
                <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
              )}
              {run.kind === 'command' && run.status === 'running'
                ? `${taskStatusLabel(run)} · ${formatTaskDuration(run.durationMs) ?? '0s'}`
                : taskDurationLabel(run.durationMs, run.kind)}
              {(run.status === 'failed' || run.status === 'cancelled') &&
                ' · ' + taskStatusLabel({ status: run.status })}
            </p>
            {command ? (
              <div className="space-y-3">
                {command.output && (
                  <pre className="text-[13px] leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap">
                    {command.output}
                  </pre>
                )}
                {run.status !== 'running' && (
                  <p className="text-muted-foreground text-xs">
                    Exit code: {command.exitCode ?? 'unavailable'}
                  </p>
                )}
              </div>
            ) : run.report ? (
              <MarkdownDocument
                text={run.report}
                className="!text-[13px] !leading-5 [overflow-wrap:anywhere]"
              />
            ) : (
              <p className="text-muted-foreground text-[13px]">
                {run.status === 'running'
                  ? 'The response will appear here when this run finishes.'
                  : 'No response was returned.'}
              </p>
            )}
            {index < task.runs.length - 1 && (
              <div aria-hidden="true" className="border-border border-t" />
            )}
          </section>
        );
      })}
    </div>
  );
}
