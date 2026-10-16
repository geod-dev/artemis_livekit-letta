import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftIcon,
  BotIcon,
  DownloadIcon,
  FileIcon,
  Loader2Icon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from 'lucide-react';
import type { ChatMessage } from '@shared/chat-types';
import { fileName } from '@/components/assistant-ui/files/workspace-file';
import { WorkspaceFilePreview } from '@/components/assistant-ui/files/workspace-file-panel';
import { MarkdownDocument } from '@/components/assistant-ui/markdown/markdown-text';
import { IconButton } from '@/components/assistant-ui/shared/icon-button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { type TaskKind, filterTaskKinds, groupAgentRuns } from '@/lib/agent-runs';
import { workspacePath, workspaceUrl } from '@/lib/attachments';
import { commandReport } from '@/lib/command-report';
import { cn } from '@/lib/shadcn/utils';
import { formatTaskDuration, taskDurationLabel, taskStatusLabel } from '@/lib/task-status';
import { readToolOutput } from '@/lib/tool-output';
import { type ActivityTask, taskTitle, useActivity } from './activity-context';
import { TaskBubble } from './task-bubble';
import { TaskLabel } from './task-label';

export type WorkspaceSelection =
  { type: 'file'; path: string } | { type: 'task'; task: ActivityTask } | null;
export type WorkspaceTab = 'files' | 'tasks';

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
      const output = readToolOutput(message.result);
      addLinks(output.text);
      if (message.name === 'present' && message.args) addLinks(message.args);
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

export function TaskStopButton({
  task,
  className,
  showSpinner = false,
}: {
  task: ActivityTask & { runs?: ActivityTask[] };
  className?: string;
  showSpinner?: boolean;
}) {
  const { stopTask, stopping } = useActivity();
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

export function WorkspacePanel({
  tab,
  setTab,
  selection,
  setSelection,
  messages,
  error,
  onClose,
}: {
  tab: WorkspaceTab;
  setTab: (tab: WorkspaceTab) => void;
  selection: WorkspaceSelection;
  setSelection: (selection: WorkspaceSelection) => void;
  messages: ChatMessage[];
  error: string | null;
  onClose: () => void;
}) {
  const { tasks: runs } = useActivity();
  const tasks = useMemo(() => groupAgentRuns(runs), [runs]);
  const [taskKinds, setTaskKinds] = useState<TaskKind[]>([]);
  const filteredTasks = filterTaskKinds(tasks, taskKinds);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 1023px)').matches);
  const contentRef = useRef<HTMLDivElement>(null);
  const openedFiles = useRef(new Set<string>());
  if (selection?.type === 'file') openedFiles.current.add(selection.path);
  const previousView = useRef<{ selection: WorkspaceSelection; tab: WorkspaceTab }>({
    selection: null,
    tab,
  });
  const listScroll = useRef({ files: 0, tasks: 0 });
  const navigation = useRef({ key: crypto.randomUUID(), depth: 0 });
  const closeRef = useRef(onClose);
  const selectionRef = useRef(selection);
  closeRef.current = onClose;
  selectionRef.current = selection;
  useEffect(() => {
    if (!mobile) return;
    const state = navigation.current;
    // Delay until the mounted view survives React's development effect replay.
    const frame = requestAnimationFrame(() => {
      const base = window.history.state;
      window.history.pushState({ ...base, workspace: state.key, detail: false }, '');
      state.depth = 1;
      if (selectionRef.current) {
        window.history.pushState(
          { ...base, workspace: state.key, detail: true, selection: selectionRef.current },
          ''
        );
        state.depth = 2;
      }
    });
    const pop = () => {
      if (window.history.state?.workspace !== state.key) {
        state.depth = 0;
        closeRef.current();
      } else if (!window.history.state.detail) {
        state.depth = 1;
        setSelection(null);
      } else if (window.history.state.selection) {
        state.depth = 2;
        setSelection(window.history.state.selection);
      }
    };
    window.addEventListener('popstate', pop);
    return () => {
      window.removeEventListener('popstate', pop);
      cancelAnimationFrame(frame);
      if (state.depth && window.history.state?.workspace === state.key)
        window.history.go(-state.depth);
      state.depth = 0;
    };
  }, [mobile, setSelection]);
  useEffect(() => {
    if (!mobile) return;
    const state = navigation.current;
    if (selection && state.depth === 1) {
      window.history.pushState({ ...window.history.state, detail: true, selection }, '');
      state.depth = 2;
    } else if (!selection && state.depth === 2) {
      state.depth = 1;
      window.history.back();
    }
  }, [mobile, selection]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1023px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const content = contentRef.current;
    const previous = previousView.current;
    if (content) {
      content.scrollTop =
        selection?.type === 'task' ? content.scrollHeight : selection ? 0 : listScroll.current[tab];
      if (selection) content.focus({ preventScroll: true });
      else if (previous.selection && previous.tab === tab) {
        const key =
          previous.selection.type === 'file' ? previous.selection.path : previous.selection.task.id;
        const button = [
          ...content.querySelectorAll<HTMLButtonElement>('[data-workspace-item]'),
        ].find((item) => item.dataset.workspaceItem === key);
        button?.focus({ preventScroll: true });
      }
    }
    previousView.current = { selection, tab };
  }, [selection, tab]);
  const selectedTask =
    selection?.type === 'task'
      ? (tasks.find((task) =>
          task.runs.some(
            (run) =>
              run.id === selection.task.id ||
              (selection.task.toolCallId && run.toolCallId === selection.task.toolCallId)
          )
        ) ?? groupAgentRuns([selection.task])[0])
      : null;
  const title =
    selection?.type === 'file'
      ? fileName(selection.path)
      : selectedTask
        ? taskTitle(selectedTask)
        : '';
  const back = () => setSelection(null);
  const selectTab = (next: WorkspaceTab) => {
    setTab(next);
    setSelection(null);
  };
  const panel = (
    <aside
      id="conversation-workspace"
      aria-label="Files and tasks"
      className="surface-panel bg-background flex h-full min-h-0 w-full flex-col border-s shadow-none lg:w-[min(30rem,38vw)] lg:shrink-0"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (selection) back();
          else onClose();
        }
      }}
    >
      {mobile && <DialogTitle className="sr-only">Files and tasks</DialogTitle>}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <div role="tablist" aria-label="Workspace" className="flex min-w-0 flex-1 gap-1">
          {(['files', 'tasks'] as const).map((item) => (
            <button
              key={item}
              id={`workspace-${item}-tab`}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls="workspace-tab-content"
              tabIndex={tab === item ? 0 : -1}
              onClick={() => selectTab(item)}
              onKeyDown={(event) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 'files'
                      : event.key === 'End'
                        ? 'tasks'
                        : item === 'files'
                          ? 'tasks'
                          : 'files';
                  selectTab(next);
                  document.getElementById(`workspace-${next}-tab`)?.focus();
                }
              }}
              className={cn(
                'focus-visible:outline-ring flex-1 rounded-[var(--control-radius)] px-3 py-1.5 text-center text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
                tab === item
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              {item === 'files' ? 'Files' : 'Tasks'}
              {item === 'tasks' && tasks.some((t) => t.status === 'running') && (
                <span className="text-muted-foreground ms-2 text-xs">
                  {tasks.filter((t) => t.status === 'running').length}
                  <span className="sr-only"> running</span>
                </span>
              )}
            </button>
          ))}
        </div>
      </header>
      {tab === 'tasks' && !selection && (
        <div
          role="group"
          aria-label="Filter tasks by type"
          className="flex shrink-0 gap-2 border-b px-4 py-3"
        >
          {(['agent', 'command'] as const).map((kind) => {
            const selected = taskKinds.includes(kind);
            const Icon = kind === 'command' ? TerminalIcon : BotIcon;
            const label = kind === 'command' ? 'Command' : 'Agent';
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={selected}
                aria-label={`${selected ? 'Remove' : 'Add'} ${label} filter`}
                onClick={() => setTaskKinds((current) => (current.includes(kind) ? [] : [kind]))}
                className={cn(
                  'focus-visible:outline-ring flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
                  selected
                    ? 'bg-foreground text-background border-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                )}
              >
                <Icon aria-hidden className="size-3.5" />
                {label}
                {selected && <XIcon aria-hidden className="size-3" />}
              </button>
            );
          })}
        </div>
      )}
      {selection && (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <IconButton label="Back to list" onClick={back} className="size-8">
            <ArrowLeftIcon className="size-4" />
          </IconButton>
          <h2 className="min-w-0 flex-1 truncate font-sans text-sm font-medium" title={title}>
            {selectedTask ? <TaskLabel task={selectedTask} /> : title}
          </h2>
          {selection.type === 'file' ? (
            <IconButton label="Download file" asChild className="size-8">
              <a
                href={workspaceUrl(selection.path, { download: true })}
                download={fileName(selection.path)}
              >
                <DownloadIcon className="size-4" />
              </a>
            </IconButton>
          ) : (
            selectedTask && <TaskStopButton task={selectedTask} className="size-8" />
          )}
        </div>
      )}
      <div
        ref={contentRef}
        id="workspace-tab-content"
        role="tabpanel"
        aria-labelledby={`workspace-${tab}-tab`}
        tabIndex={0}
        onScroll={(event) => {
          if (!selection) listScroll.current[tab] = event.currentTarget.scrollTop;
        }}
        className="min-h-0 flex-1 overflow-auto overscroll-contain focus-visible:outline-none"
      >
        {error && (
          <p role="alert" className="text-destructive px-5 py-3 text-sm">
            {error}
          </p>
        )}
        {selection?.type === 'file' ? (
          <WorkspaceFilePreview path={selection.path} />
        ) : selectedTask ? (
          <div className="space-y-8 p-5">
            {selectedTask.runs.map((run, index) => {
              const command = run.kind === 'command' ? commandReport(run) : null;
              return (
                <section key={run.id} className="space-y-3">
                  {index > 0 && (
                    <h3 className="text-sm font-medium">
                      <TaskLabel task={{ ...run, title: run.rerunName ?? run.title }} />
                    </h3>
                  )}
                  <TaskBubble
                    description={
                      run.kind === 'command' ? taskTitle(run) : (run.rerunName ?? run.title)
                    }
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
                  {index < selectedTask.runs.length - 1 && (
                    <div aria-hidden="true" className="border-border border-t" />
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="px-4 py-4">
            {tab === 'files'
              ? conversationFiles(
                  messages,
                  openedFiles.current,
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
                              onClick={() => setSelection({ type: 'file', path })}
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
                  const rows = filteredTasks.filter((t) =>
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
                                onClick={() => setSelection({ type: 'task', task })}
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
        )}
      </div>
    </aside>
  );
  if (!mobile) return panel;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        asChild
        showCloseButton={false}
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (selection) {
            event.preventDefault();
            back();
          }
        }}
        className="!fixed !inset-x-0 !top-[var(--app-top,0px)] !z-50 !h-[var(--app-height,100dvh)] !max-h-none !w-full !max-w-none !translate-x-0 !translate-y-0 !gap-0 !overflow-hidden !rounded-none !border-0 !p-0"
      >
        {panel}
      </DialogContent>
    </Dialog>
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
