import type { ConversationEvent } from '@artemis/contracts/chat-types';
import type { RunningTask } from './conversation-state.ts';

/** A turn that started is listed once, in the order it started. */
export function startTurn(turns: string[], turnId: string): string[] {
  return turns.includes(turnId) ? turns : [...turns, turnId];
}

/** A turn that settled leaves the active list. */
export function endTurn(turns: string[], turnId: string): string[] {
  return turns.filter((id) => id !== turnId);
}

/** The turns a snapshot reports as active, each once. */
export function snapshotTurnIds(
  turns: Extract<ConversationEvent, { type: 'snapshot' }>['turns']
): string[] {
  return [...new Set(turns.map((turn) => turn.turnId))];
}

/** The running tasks a snapshot reports. */
export function snapshotTasks(
  tasks: Extract<ConversationEvent, { type: 'snapshot' }>['tasks']
): RunningTask[] {
  return tasks
    .filter((task) => task.status === 'running')
    .map((task) => ({ id: task.taskId, title: task.title, status: 'running' as const }));
}

/**
 * The task list after a `task` event: a running task replaces its earlier entry, and a
 * task that is no longer running leaves the list.
 */
export function applyTaskEvent(
  tasks: RunningTask[],
  event: Extract<ConversationEvent, { type: 'task' }>
): RunningTask[] {
  const rest = tasks.filter((task) => task.id !== event.taskId);
  return event.status === 'running'
    ? [
        ...rest,
        {
          id: event.taskId,
          title: event.title,
          status: event.status,
          ...(event.kind ? { kind: event.kind } : {}),
        },
      ]
    : rest;
}
