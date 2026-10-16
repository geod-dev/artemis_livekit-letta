import type { ConversationTask } from '@shared/chat-types';

export function formatTaskDuration(durationMs: number | undefined): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours ? `${hours}h` : ''}${minutes ? `${minutes}min` : ''}${seconds || (!hours && !minutes) ? `${seconds}s` : ''}`;
}

/** Duration wording shared by completion notes and run details. */
export function taskDurationLabel(
  durationMs: number | undefined,
  kind?: ConversationTask['kind']
): string {
  const duration = formatTaskDuration(durationMs);
  if (kind === 'command') return duration ? 'Executed in ' + duration : 'Executed';
  return duration ? 'Worked for ' + duration : 'Worked';
}

/** Status wording for failures and cancellation. */
export function taskStatusLabel(
  task: Pick<ConversationTask, 'status' | 'durationMs' | 'kind'>
): string {
  if (task.status === 'running') return task.kind === 'command' ? 'Running' : 'Working';
  const duration = formatTaskDuration(task.durationMs);
  if (task.status === 'failed') return `Failed${duration ? ` after ${duration}` : ''}`;
  if (task.status === 'cancelled') return `Stopped${duration ? ` after ${duration}` : ''}`;
  return `Done${duration ? ` in ${duration}` : ''}`;
}
