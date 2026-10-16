import { createContext, useContext } from 'react';
import { type AgentRun, stripLeadingEmoji } from '@/lib/agent-runs';

export type ActivityTask = AgentRun;

export function taskTitle(task: Pick<ActivityTask, 'title' | 'kind'>): string {
  const title = (task.title.trim() || 'Background task')
    .replace(/^Background task (?:finished|failed|stopped):\s*/i, '')
    .replace(/\s+-\s+background task (?:finished|failed|stopped)$/i, '');
  if (task.kind === 'command') return stripLeadingEmoji(title).trim() || 'Command';
  return /^\p{Extended_Pictographic}/u.test(title) ? title : `🔎 ${title}`;
}

export const ActivityContext = createContext<{
  tasks: ActivityTask[];
  openTask: (task: ActivityTask) => void;
  stopTask: (id: string) => Promise<void>;
  stopping: Set<string>;
  error: string | null;
} | null>(null);

export function useActivity() {
  const context = useContext(ActivityContext);
  if (!context) throw new Error('ActivityContext is missing');
  return context;
}
