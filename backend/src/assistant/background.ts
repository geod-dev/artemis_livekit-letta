import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage, TurnMode } from '../chat-types';
import { wakesThread } from './background-policy';
import { type UpdateRecord, originKey, save, state } from './background-store';
import { activeCall, announceUpdate, onCallEnded } from './calls';
import { publish, publishList } from './events';
import { updateLabel } from './messages';
import { conversationRuntime } from './runtime';
import {
  type TaskNotification,
  extractTaskNotifications,
  parseBackgroundStart,
} from './task-notifications';

/**
 * Integration of Letta's native background workers with the chat and calls.
 *
 * Letta runs the workers (the `Agent` tool), owns their identifiers,
 * conversations and reports, and stops them (`TaskStop`). The gateway adds
 * what the assistant's chat and voice experience needs:
 * - the originating thread and its mode, captured when a worker starts;
 * - whether a finished task wakes that thread (`wakesThread`);
 * - how the result is delivered, from the actual call state at that moment:
 *   a concise spoken update during a live call, otherwise a text reply at low
 *   effort, or held for the conversation's next turn;
 * - read state: a delivered result stays unread until it is seen in the chat
 *   or heard completely in a call.
 *
 * Notifications reach the gateway through the Letta mod `letta/notifications.mjs`.
 */

/**
 * A tool result of a turn in this conversation. When it reports background
 * work (a worker started by `Agent`, or a command Letta moved to the
 * background), remember where the work came from.
 */
export function taskStarted(input: {
  conversationId: string;
  mode: TurnMode;
  depth: number;
  title: string;
  toolResult: string;
  /** Started by the `Agent` tool: shown as running work in the chat. */
  worker: boolean;
}): void {
  const started = parseBackgroundStart(input.toolResult);
  if (!started) return;
  const key = originKey(input.conversationId, started.taskId);
  // A command reported as still running keeps the origin of its first report.
  if (state().origins[key] && !input.worker) return;
  state().origins[key] = {
    conversationId: input.conversationId,
    taskId: started.taskId,
    ...(started.workerConversationId ? { workerConversationId: started.workerConversationId } : {}),
    title: input.title,
    mode: input.mode,
    depth: input.depth,
    startedAt: new Date().toISOString(),
  };
  save();
  if (!input.worker) return;
  publish(input.conversationId, {
    type: 'task',
    taskId: started.taskId,
    status: 'running',
    title: input.title,
  });
}

/** `TaskStop` was called: the task's failure notification reports a deliberate stop. */
export function taskStopRequested(conversationId: string, taskId: string): void {
  const origin = state().origins[originKey(conversationId, taskId)];
  if (!origin) return;
  origin.stopped = true;
  save();
}

/** Notifications forwarded by the Letta mod for one conversation. */
export function receiveNotifications(conversationId: string, raw: readonly string[]): number {
  let accepted = 0;
  for (const text of raw) {
    for (const notification of extractTaskNotifications(text).notifications) {
      if (handle(conversationId, notification)) accepted++;
    }
  }
  return accepted;
}

function handle(conversationId: string, n: TaskNotification): boolean {
  const s = state();
  const fingerprint = [
    conversationId,
    n.taskId,
    n.workerConversationId ?? '',
    n.status,
    createHash('sha1').update(n.report).digest('hex').slice(0, 12),
  ].join('|');
  if (s.seen.includes(fingerprint)) return false;
  s.seen.push(fingerprint);

  // Task ids restart with the Letta server; the worker conversation disambiguates.
  const key = originKey(conversationId, n.taskId);
  const candidate = s.origins[key];
  const origin =
    candidate &&
    (!candidate.workerConversationId ||
      !n.workerConversationId ||
      candidate.workerConversationId === n.workerConversationId)
      ? candidate
      : undefined;
  if (origin) delete s.origins[key];

  const update: UpdateRecord = {
    id: `update-${randomUUID().slice(0, 12)}`,
    conversationId,
    title:
      origin?.title ??
      (n.summary.replace(/^Agent "(.*)" (completed|failed)$/, '$1') || 'Background task'),
    status: origin?.stopped && n.status === 'failed' ? 'cancelled' : n.status,
    needsInput: n.needsInput,
    report: n.report,
    depth: origin?.depth ?? 0,
    delivery: 'held',
    unread: true,
    createdAt: new Date().toISOString(),
  };
  s.updates[update.id] = update;
  publish(conversationId, {
    type: 'task',
    taskId: n.taskId,
    status: 'finished',
    title: update.title,
  });

  // Work without a known origin (e.g. started natively) is treated as text work.
  if (wakesThread(update, origin?.mode ?? 'text')) deliver(update);
  save();
  publishUnread(conversationId);
  console.info(
    `[background] ${n.taskId} ${update.status} in ${conversationId}: ${update.delivery}` +
      (update.needsInput ? ' (needs input)' : '')
  );
  return true;
}

/** Deliver a waking update according to the call state right now. */
function deliver(update: UpdateRecord): void {
  const call = activeCall(update.conversationId);
  if (call && announceUpdate(update.conversationId, update.id)) {
    update.delivery = 'queued';
    return;
  }
  deliverAsText(update);
}

function deliverAsText(update: UpdateRecord): void {
  update.delivery = 'delivered';
  void conversationRuntime(update.conversationId)
    .run({ kind: 'update', modality: 'text', effort: 'low', text: '', updates: [update] })
    .then(() => publishUnread(update.conversationId));
}

// Updates announced to a call that ended before they were spoken go to the chat.
onCallEnded('background-updates', (conversationId, pending) => {
  const s = state();
  for (const id of pending) {
    const update = s.updates[id];
    if (update?.delivery === 'queued') deliverAsText(update);
  }
  save();
});

/** A queued update the voice agent is about to speak; it becomes part of the conversation. */
export function takeQueuedUpdate(conversationId: string, id: string): UpdateRecord | null {
  const update = state().updates[id];
  if (!update || update.conversationId !== conversationId || update.delivery !== 'queued') {
    return null;
  }
  update.delivery = 'delivered';
  save();
  return update;
}

/** Held updates join the conversation's next turn. */
export function takeHeldUpdates(conversationId: string): UpdateRecord[] {
  const held = Object.values(state().updates)
    .filter((u) => u.conversationId === conversationId && u.delivery === 'held')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (held.length === 0) return held;
  for (const update of held) update.delivery = 'delivered';
  save();
  return held;
}

/** The depth of work started while answering these updates. */
export function depthAfter(updates: readonly UpdateRecord[]): number {
  return updates.length ? Math.max(...updates.map((u) => u.depth)) + 1 : 0;
}

/** Read in the chat, or heard completely in a call. */
export function markRead(conversationId: string, ids: readonly string[]): void {
  let changed = false;
  for (const id of ids) {
    const update = state().updates[id];
    if (update?.conversationId === conversationId && update.unread) {
      update.unread = false;
      changed = true;
    }
  }
  if (!changed) return;
  save();
  publish(conversationId, { type: 'updates_changed' });
  publishUnread(conversationId);
}

export function unreadCount(conversationId: string): number {
  return Object.values(state().updates).filter(
    (u) => u.conversationId === conversationId && u.unread
  ).length;
}

function publishUnread(conversationId: string): void {
  publish(conversationId, { type: 'updates_changed' });
  publishList({ type: 'unread', conversationId, unread: unreadCount(conversationId) });
}

/**
 * Add read state to a conversation's history, and show held updates (not yet
 * part of the conversation) after it.
 */
export function withUpdates(conversationId: string, rows: ChatMessage[]): ChatMessage[] {
  const updates = state().updates;
  const marked = rows.map((row) =>
    row.role === 'event' && row.updateId && updates[row.updateId]?.unread
      ? { ...row, unread: true }
      : row
  );
  const held = Object.values(updates)
    .filter((u) => u.conversationId === conversationId && u.delivery !== 'delivered')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((u): ChatMessage => ({
      id: `pending-update:${u.id}`,
      role: 'event',
      kind: 'task_result',
      text: updateLabel(u.title, u.status, u.needsInput),
      updateId: u.id,
      detail: u.report,
      unread: u.unread,
      createdAt: u.createdAt,
    }));
  return [...marked, ...held];
}
