/**
 * Parsing of Letta's native background-task texts: the result of the `Agent`
 * tool when it starts a worker, and the `<task-notification>` it delivers when
 * the worker finishes. Pure functions so they can be unit tested.
 */

/**
 * Background work started by a tool, from its immediate result: a worker
 * started by `Agent`, or a command Letta moved to the background (`Bash`).
 */
export interface StartedTask {
  taskId: string;
  workerAgentId?: string;
  workerConversationId?: string;
}

export function parseBackgroundStart(result: string, expectedKind?: 'agent' | 'command'): StartedTask | null {
  const agentId = expectedKind === 'command' ? undefined :
    result.match(/^(?:Task running in background with task ID: |Background task ID: )([^\s\\]+)(?:\r?\n|$)/)?.[1];
  const commandId = expectedKind === 'agent' ? undefined :
    result.match(/^Command (?:running in background with ID: |is still running with task ID: )([^\s\\]+)(?:\r?\n|$)/)?.[1];
  const taskId = agentId ?? commandId;
  if (!taskId) return null;
  const workerAgentId = result.match(/^Agent ID: (\S+)/m)?.[1];
  const workerConversationId = result.match(/^Conversation ID: (\S+)/m)?.[1];
  return {
    taskId,
    ...(workerAgentId ? { workerAgentId } : {}),
    ...(workerConversationId ? { workerConversationId } : {}),
  };
}

/** A completion notification from Letta's background task system. */
export interface TaskNotification {
  taskId: string;
  status: 'completed' | 'failed';
  summary: string;
  /** The worker's report (or error) without Letta's metadata header. */
  report: string;
  durationMs?: number;
  /** Set for `Agent` workers. */
  subagentType?: string;
  workerConversationId?: string;
  /** The worker's report starts with the needs-input marker. */
  needsInput: boolean;
}

/** First line of a worker report that cannot finish without the user. */
export const NEEDS_INPUT_MARKER = 'NEEDS USER INPUT:';

const BLOCK =
  /<task-notification>([\s\S]*?)<\/task-notification>(?:\nFull transcript available at: [^\n]*)?/g;

/**
 * Split text into the task notifications it contains and the remaining text.
 * Reflection displays and monitor events (no task id or status) stay in the text.
 */
export function extractTaskNotifications(text: string): {
  notifications: TaskNotification[];
  rest: string;
} {
  const notifications: TaskNotification[] = [];
  const rest = text.replace(BLOCK, (block, inner: string) => {
    const parsed = parseNotification(inner);
    if (!parsed) return block;
    notifications.push(parsed);
    return '';
  });
  return { notifications, rest: rest.trim() };
}

function parseNotification(inner: string): TaskNotification | null {
  const field = (name: string) => inner.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
  const taskId = field('task-id')?.trim();
  const status = field('status')?.trim();
  if (!taskId || (status !== 'completed' && status !== 'failed')) return null;

  const result = unescapeXml(field('result') ?? '').trim();
  const header = result.match(/^(subagent_type=\S+[^\n]*)\n?/);
  const attrs = header
    ? Object.fromEntries([...header[1].matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]))
    : {};
  const report = (header ? result.slice(header[0].length) : result).trim();
  const duration = field('usage')?.match(/\bduration_ms:\s*(\d+)\b/)?.[1];
  const durationMs = duration === undefined ? undefined : Number(duration);

  return {
    taskId,
    status,
    summary: unescapeXml(field('summary') ?? '').trim(),
    report,
    ...(durationMs !== undefined && Number.isSafeInteger(durationMs) && durationMs >= 0 ? { durationMs } : {}),
    ...(attrs.subagent_type ? { subagentType: attrs.subagent_type } : {}),
    ...(attrs.conversation_id ? { workerConversationId: attrs.conversation_id } : {}),
    needsInput: report.startsWith(NEEDS_INPUT_MARKER),
  };
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
