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

function record(text: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text ?? '');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
const string = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

/** Remove one leading emoji from a rerun label when the agent name already carries it. */
export function stripLeadingEmoji(value: string): string {
  return value.replace(
    /^(?:(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?)*)|\p{Regional_Indicator}{2})\s*/u,
    ''
  );
}

function receiptText(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((part) => string(part?.text) ?? '').join('\n');
    if (
      parsed &&
      typeof parsed === 'object' &&
      'content' in parsed &&
      Array.isArray(parsed.content)
    )
      return parsed.content.map((part) => string(part?.text) ?? '').join('\n');
  } catch {
    /* Native receipts are usually plain text. */
  }
  return value;
}

/** Recover run identity and prompts from persisted tool receipts, including older tasks. */
export function taskRuns(tasks: ConversationTask[], messages: ChatMessage[]): AgentRun[] {
  const rows = new Map<string, AgentRun>(tasks.map((task) => [task.id, { ...task }]));
  const order = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== 'tool' || !['Agent', 'Task'].includes(message.name)) continue;
    const args = record(message.args);
    const receipt = receiptText(message.result);
    const id = receipt.match(/\btask ID: (\S+)/)?.[1];
    if (!id) continue;
    const agent = receipt.match(/^Agent ID: (\S+)/m)?.[1] ?? string(args.agent_id);
    const conversation =
      receipt.match(/^Conversation ID: (\S+)/m)?.[1] ?? string(args.conversation_id);
    const existing = rows.get(id);
    rows.set(id, {
      ...existing,
      id,
      title: string(args.description) ?? existing?.title ?? 'Agent',
      kind: 'agent',
      status: existing?.status ?? 'running',
      agentKey: agent
        ? `agent:${agent}`
        : conversation && conversation !== 'default'
          ? `conversation:${conversation}`
          : `task:${id}`,
      toolCallId: message.toolCallId,
      prompt: string(args.prompt),
      startedAt: message.createdAt,
    });
    if (!order.has(id)) order.set(id, order.size);
  }
  for (const message of messages) {
    if (message.role !== 'event' || message.kind !== 'task_result') continue;
    const existing = message.taskId
      ? rows.get(message.taskId)
      : [...rows.values()].find((row) => row.updateId === message.updateId && message.updateId);
    const id = existing?.id ?? message.taskId;
    if (!id) continue;
    rows.set(id, {
      ...existing,
      id,
      title: existing?.title ?? message.text,
      status: message.status ?? existing?.status ?? 'completed',
      updateId: message.updateId ?? existing?.updateId,
      durationMs: message.durationMs ?? existing?.durationMs,
      report: message.detail ?? existing?.report,
    });
  }
  const runs = [...rows.values()].sort((a, b) => {
    const ai = order.get(a.id),
      bi = order.get(b.id);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return 0;
  });
  const names = new Map<string, string>();
  return runs.map((run) => {
    const key = run.agentKey ?? `task:${run.id}`;
    const rerunName = names.has(key) ? run.title : undefined;
    if (!names.has(key)) names.set(key, run.title);
    return { ...run, agentKey: key, agentTitle: names.get(key), rerunName };
  });
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

/** Only active runs advance; completed runs keep their recorded worker duration. */
export function runDuration(run: AgentRun, now: number): number | undefined {
  if (run.status !== 'running') return run.durationMs;
  const start = Date.parse(run.startedAt ?? '');
  return Number.isFinite(start) ? Math.max(run.durationMs ?? 0, now - start, 0) : run.durationMs;
}
