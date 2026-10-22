import type { ChatMessage, ConversationTask } from '@shared/chat-types';

export type AgentRun = ConversationTask & {
  agentKey?: string;
  agentTitle?: string;
  rerunName?: string;
  toolCallId?: string;
  prompt?: string;
  startedAt?: string;
};
export type AgentHistory = AgentRun & { runs: AgentRun[] };

/** Remove one leading emoji from a rerun label when the agent name already carries it. */
export function stripLeadingEmoji(value: string): string {
  return value.replace(
    /^(?:(?:\p{Extended_Pictographic}(?:️|︎)?\p{Emoji_Modifier}?(?:‍\p{Extended_Pictographic}(?:️|︎)?\p{Emoji_Modifier}?)*)|\p{Regional_Indicator}{2})\s*/u,
    ''
  );
}

/**
 * The root of a follow-up chain: the first task a resumed subagent continues
 * from, or the task itself. A task whose ancestor is unknown keeps that
 * ancestor's id, so the chain still groups.
 */
function rootTaskId(task: ConversationTask, known: Map<string, ConversationTask>): string {
  let id = task.resumedFromTaskId ?? task.id;
  for (let hops = 0; hops < known.size; hops++) {
    const parent = known.get(id)?.resumedFromTaskId;
    if (!parent) break;
    id = parent;
  }
  return id;
}

/**
 * The background tasks of a conversation as runs, in the order they started.
 * Identity, tool calls and prompts come from the tasks the server reports;
 * completion events from the gateway refresh the runs they name.
 */
export function taskRuns(tasks: ConversationTask[], messages: ChatMessage[]): AgentRun[] {
  const known = new Map<string, ConversationTask>(
    tasks
      .filter((task) => task.kind === 'agent' || task.kind === 'command')
      .map((task) => [task.id, task])
  );
  const rows = new Map<string, AgentRun>();
  for (const task of known.values()) {
    const key = task.kind === 'command' ? `command:${task.id}` : `agent:${rootTaskId(task, known)}`;
    rows.set(task.id, { ...task, agentKey: key });
  }
  for (const message of messages) {
    if (message.role !== 'event' || message.kind !== 'task_result') continue;
    const existing = message.taskId
      ? rows.get(message.taskId)
      : [...rows.values()].find((row) => row.updateId === message.updateId && message.updateId);
    // An event alone does not establish a task's type. Enrich known tasks only.
    if (!existing) continue;
    rows.set(existing.id, {
      ...existing,
      status: message.status ?? existing.status,
      updateId: message.updateId ?? existing.updateId,
      durationMs: message.durationMs ?? existing.durationMs,
      report: message.detail ?? existing.report,
    });
  }
  const runs = [...rows.values()].sort((a, b) => startOrder(a) - startOrder(b));
  const names = new Map<string, string>();
  return runs.map((run) => {
    const key = run.agentKey ?? `task:${run.id}`;
    const rerunName = names.has(key) ? run.title : undefined;
    if (!names.has(key)) names.set(key, run.title);
    return { ...run, agentKey: key, agentTitle: names.get(key), rerunName };
  });
}

/** Sort key of a run's start: earlier starts first, unknown starts last. */
function startOrder(run: AgentRun): number {
  const start = Date.parse(run.startedAt ?? '');
  return Number.isFinite(start) ? start : Number.POSITIVE_INFINITY;
}

/** Panel totals are independent of the duration shown for each individual run. */
export function groupAgentRuns(runs: AgentRun[]): AgentHistory[] {
  const groups = new Map<string, AgentRun[]>();
  for (const run of runs) {
    const key = run.agentKey ?? `task:${run.id}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  return [...groups.values()].map((history) => {
    const first = history[0];
    const latest = history.at(-1)!;
    const running = history.find((run) => run.status === 'running');
    const durations = history.flatMap((run) =>
      run.durationMs === undefined ? [] : [run.durationMs]
    );
    return {
      ...latest,
      id: first.id,
      title: first.agentTitle ?? first.title,
      agentTitle: first.agentTitle ?? first.title,
      status: running ? 'running' : latest.status,
      durationMs: durations.length ? durations.reduce((sum, ms) => sum + ms, 0) : undefined,
      runs: history,
    };
  });
}

/** A command run's command line and output, from what the server recorded for it. */
export function commandOutput(
  run: Pick<ConversationTask, 'command' | 'prompt' | 'stdout' | 'stderr' | 'report' | 'exitCode'>
) {
  const output =
    run.stdout !== undefined || run.stderr !== undefined
      ? [run.stdout, run.stderr].filter(Boolean).join('\n')
      : (run.report ?? '');
  return {
    command: run.command ?? run.prompt,
    output,
    exitCode: typeof run.exitCode === 'number' ? run.exitCode : undefined,
  };
}

export type TaskKind = 'agent' | 'command';

/** Selected types are combined; an empty selection shows every task. */
export function filterTaskKinds<T extends Pick<ConversationTask, 'kind'>>(
  tasks: T[],
  selected: readonly TaskKind[]
): T[] {
  return selected.length ? tasks.filter((task) => selected.includes(task.kind ?? 'agent')) : tasks;
}

/** Only active runs advance; completed runs keep their recorded worker duration. */
export function runDuration(run: AgentRun, now: number): number | undefined {
  if (run.status !== 'running') return run.durationMs;
  const start = Date.parse(run.startedAt ?? '');
  return Number.isFinite(start) ? Math.max(run.durationMs ?? 0, now - start, 0) : run.durationMs;
}
