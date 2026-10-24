import { type AgentRun, stripLeadingEmoji } from '@/lib/agent-runs';

/** The name a background task shows: its title without the finished/failed wording. */
export function taskTitle(task: Pick<AgentRun, 'title' | 'kind'>): string {
  const title = (task.title.trim() || 'Background task')
    .replace(/^Background task (?:finished|failed|stopped):\s*/i, '')
    .replace(/\s+-\s+background task (?:finished|failed|stopped)$/i, '');
  if (task.kind === 'command') return stripLeadingEmoji(title).trim() || 'Command';
  return /^\p{Extended_Pictographic}/u.test(title) ? title : `🔎 ${title}`;
}
