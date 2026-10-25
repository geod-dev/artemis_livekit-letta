import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, BotIcon, DownloadIcon, TerminalIcon, XIcon } from 'lucide-react';
import type { ChatMessage } from '@artemis/contracts/chat-types';
import { fileName } from '@/components/files/workspace-file';
import { WorkspaceFilePreview } from '@/components/files/workspace-file-panel';
import { WorkspaceList } from '@/components/files/workspace-panel-list';
import { WorkspaceTaskDetail } from '@/components/files/workspace-task-detail';
import { TaskLabel } from '@/components/tasks/task-label';
import { TaskStopButton } from '@/components/tasks/task-stop-button';
import { taskTitle } from '@/components/tasks/task-title';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { useAppActivity } from '@/hooks/use-app-activity';
import { useWorkspaceHistory } from '@/hooks/use-workspace-history';
import { type TaskKind, filterTaskKinds, groupAgentRuns } from '@/lib/agent-runs';
import type { AgentRun } from '@/lib/agent-runs';
import { workspaceUrl } from '@/lib/attachments';
import { cn } from '@/lib/shadcn/utils';

export type WorkspaceSelection =
  { type: 'file'; path: string } | { type: 'task'; task: AgentRun } | null;
export type WorkspaceTab = 'files' | 'tasks';

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
  const { tasks: runs } = useAppActivity();
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
  useWorkspaceHistory({ mobile, selection, setSelection, onClose });
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
          <WorkspaceTaskDetail task={selectedTask} />
        ) : (
          <WorkspaceList
            tab={tab}
            messages={messages}
            opened={openedFiles.current}
            runs={runs}
            tasks={filteredTasks}
            onSelect={setSelection}
          />
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
