import { Fragment } from 'react';
import { DownloadIcon, FileIcon } from 'lucide-react';
import type { ChatMessage } from '@artemis/contracts/chat-types';
import { TOOL_NAMES } from '@artemis/contracts/tool-names';
import { fileName } from '@/components/files/workspace-file';
import type { WorkspaceSelection, WorkspaceTab } from '@/components/files/workspace-panel';
import type { TaskGroup } from '@/components/files/workspace-task-detail';
import { TaskLabel } from '@/components/tasks/task-label';
import { TaskStopButton } from '@/components/tasks/task-stop-button';
import { IconButton } from '@/components/ui/icon-button';
import type { AgentRun } from '@/lib/agent-runs';
import { workspacePath, workspaceUrl } from '@/lib/attachments';
import { formatTaskDuration, taskStatusLabel } from '@/lib/task-status';
import { readToolOutput } from '@/lib/tool-output';

/** Only files referenced in this conversation belong in its workspace list. */
function conversationFiles(messages: ChatMessage[], opened: Set<string>, reports: string[]) {
  const attachments = new Map<string, string>();
  const outputs = new Map<string, string>();
  const addLinks = (text: string) => {
    for (const match of text.matchAll(/!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
      const path = workspacePath(match[1]);
      if (path) outputs.set(path, fileName(path));
    }
  };
  for (const message of messages) {
    if (message.role === 'user') {
      for (const file of message.attachments ?? []) attachments.set(file.path, file.name);
    } else if (message.role === 'assistant' || message.role === 'event') {
      const text =
        message.role === 'event' ? `${message.text}\n${message.detail ?? ''}` : message.text;
      addLinks(text);
    } else if (message.role === 'tool') {
      const output = readToolOutput(message.result, message.display);
      addLinks(output.text);
      if (message.name === TOOL_NAMES.present && message.args) addLinks(message.args);
      for (const artifact of output.artifacts) {
        const path = workspacePath(artifact.url);
        if (path) outputs.set(path, artifact.name);
      }
    }
  }
  reports.forEach(addLinks);
  for (const path of opened) if (!attachments.has(path)) outputs.set(path, fileName(path));
  for (const path of attachments.keys()) outputs.delete(path);
  return [
    { title: 'Attachments', entries: [...attachments] },
    { title: 'Outputs', entries: [...outputs] },
  ];
}

const actionClass =
  'size-8 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:size-10 [@media(hover:none)]:opacity-100';

export function WorkspaceList({
  tab,
  messages,
  opened,
  runs,
  tasks,
  onSelect,
}: {
  tab: WorkspaceTab;
  messages: ChatMessage[];
  opened: Set<string>;
  runs: AgentRun[];
  tasks: TaskGroup[];
  onSelect: (selection: WorkspaceSelection) => void;
}) {
  return (
    <div className="px-4 py-4">
      {tab === 'files'
        ? conversationFiles(
            messages,
            opened,
            runs.flatMap((run) => (run.report ? [run.report] : []))
          ).map((group) => (
            <Fragment key={group.title}>
              <GroupLabel>{group.title}</GroupLabel>
              {group.entries.length ? (
                <ul className="space-y-0.5">
                  {group.entries.map(([path, name]) => (
                    <li
                      key={path}
                      className="group hover:bg-muted/60 focus-within:bg-muted/60 flex items-center rounded-lg"
                    >
                      <button
                        type="button"
                        data-workspace-item={path}
                        onClick={() => onSelect({ type: 'file', path })}
                        className="focus-visible:outline-ring flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-3 text-left text-sm focus-visible:outline-2"
                      >
                        <FileIcon className="text-muted-foreground size-4 shrink-0" />
                        <span className="truncate" title={path}>
                          {name}
                        </span>
                      </button>
                      <IconButton label={`Download ${name}`} asChild className={actionClass}>
                        <a href={workspaceUrl(path, { download: true })} download={name}>
                          <DownloadIcon className="size-4" />
                        </a>
                      </IconButton>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyRow>
                  {group.title === 'Attachments'
                    ? 'Files you attach will appear here.'
                    : 'Files shared by the assistant will appear here.'}
                </EmptyRow>
              )}
            </Fragment>
          ))
        : ['Running', 'Done'].map((group) => {
            const rows = tasks.filter((t) =>
              group === 'Running' ? t.status === 'running' : t.status !== 'running'
            );
            return (
              <Fragment key={group}>
                <GroupLabel>{group}</GroupLabel>
                {rows.length ? (
                  <ul className="space-y-0.5">
                    {rows.map((task) => (
                      <li
                        key={task.id}
                        className="group hover:bg-muted/60 focus-within:bg-muted/60 flex items-center rounded-lg"
                      >
                        <button
                          type="button"
                          data-workspace-item={task.id}
                          onClick={() => onSelect({ type: 'task', task })}
                          className="focus-visible:outline-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-3 text-left text-sm focus-visible:outline-2"
                        >
                          <span className="flex min-w-0 flex-1 items-baseline gap-1">
                            <TaskLabel task={task} />
                            {task.runs.length > 1 && (
                              <span
                                className="text-muted-foreground/60 shrink-0 text-xs"
                                aria-label={task.runs.length + ' runs'}
                              >
                                · {task.runs.length}
                              </span>
                            )}
                          </span>
                          {task.durationMs !== undefined && (
                            <span className="text-muted-foreground shrink-0 text-xs">
                              {formatTaskDuration(task.durationMs)}
                            </span>
                          )}

                          <span className="sr-only">
                            {task.status === 'running' ? taskStatusLabel(task) : ''}
                          </span>
                        </button>
                        <TaskStopButton
                          task={task}
                          showSpinner
                          className="size-8 shrink-0 [@media(hover:none)]:size-10"
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyRow>
                    {group === 'Running' ? 'No tasks running.' : 'No finished tasks.'}
                  </EmptyRow>
                )}
              </Fragment>
            );
          })}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-muted-foreground/60 px-px pt-5 pb-2 text-xs font-medium first:pt-1">
      {children}
    </h3>
  );
}
function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground px-2 py-3 text-sm">{children}</p>;
}
