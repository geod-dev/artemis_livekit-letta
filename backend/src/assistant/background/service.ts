import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage, ConversationEvent, ConversationListEvent, TurnMode } from '../../chat-types';
import { wakesThread } from './policy.ts';
import { type BackgroundState, type TaskOrigin, type UpdateRecord, originKey, snapshot, transact } from './store.ts';
import { type TaskNotification, extractTaskNotifications, parseBackgroundStart } from './task-notifications.ts';

interface UpdateRunRequest {
  kind: 'update';
  modality: 'text' | 'voice';
  effort?: 'low';
  text: '';
  updates: UpdateRecord[];
}

/** Runtime and event dependencies are supplied by server composition, avoiding a runtime cycle. */
export interface BackgroundPorts {
  isCallActive(conversationId: string): boolean;
  announceUpdate(conversationId: string, id: string): boolean;
  onCallEnded(key: string, listener: (conversationId: string, pending: string[]) => void): void;
  runUpdate(conversationId: string, request: UpdateRunRequest): Promise<{ success: boolean; error?: string }>;
  publish(conversationId: string, event: ConversationEvent): void;
  publishList(event: ConversationListEvent): void;
  updateLabel(title: string, status: UpdateRecord['status'], needsInput: boolean): string;
}

let ports: BackgroundPorts | undefined;

export function configureBackgroundPorts(next: BackgroundPorts): void {
  ports = next;
  next.onCallEnded('background-updates', (conversationId, pending) => {
    void onCallEnded(conversationId, pending).catch((error) =>
      console.error('[background] could not move pending call updates', error)
    );
  });
}

function dependencies(): BackgroundPorts {
  if (!ports) throw new Error('Background ports have not been configured');
  return ports;
}

/** Remember where work reported by Letta started. */
export async function taskStarted(input: {
  conversationId: string;
  mode: TurnMode;
  depth: number;
  title: string;
  toolResult: string;
  worker: boolean;
}): Promise<void> {
  const started = parseBackgroundStart(input.toolResult);
  if (!started) return;
  const key = originKey(input.conversationId, started.taskId);
  const shouldPublish = await transact((s) => {
    if (s.origins[key] && !input.worker) return false;
    const origin: TaskOrigin = {
      conversationId: input.conversationId,
      taskId: started.taskId,
      ...(started.workerConversationId ? { workerConversationId: started.workerConversationId } : {}),
      title: input.title,
      mode: input.mode,
      depth: input.depth,
      startedAt: new Date().toISOString(),
    };
    s.origins[key] = origin;
    return input.worker;
  });
  if (shouldPublish) safely(() => dependencies().publish(input.conversationId, {
    type: 'task', taskId: started.taskId, status: 'running', title: input.title,
  }));
}

export async function taskStopRequested(conversationId: string, taskId: string): Promise<void> {
  await transact((s) => {
    const origin = s.origins[originKey(conversationId, taskId)];
    if (origin) origin.stopped = true;
  });
}

/** Notifications are accepted only after the state transition is durably saved. */
export async function receiveNotifications(conversationId: string, raw: readonly string[]): Promise<number> {
  const candidates: TaskNotification[] = [];
  for (const text of raw) candidates.push(...extractTaskNotifications(text).notifications);
  if (!candidates.length) return 0;
  const deliveries: Array<{ id: string; conversationId: string }> = [];
  const publishTasks: Array<{ taskId: string; title: string; conversationId: string }> = [];
  const result = await transact((s) => {
    const route = resolveRetired(s.retired, conversationId);
    // An archived conversation has no destination. Accept-and-discard exact
    // callbacks so the Letta mod never falls back to native delivery there.
    if (route === null) return { accepted: 0, targetConversationId: null };
    const targetConversationId = route ?? conversationId;
    let count = 0;
    for (const n of candidates) {
      // Keep the source ID in the idempotency key even after a fork. Retries
      // from the worker always identify the conversation where it was started.
      const fingerprint = [conversationId, n.taskId, n.workerConversationId ?? '', n.status,
        createHash('sha1').update(n.report).digest('hex').slice(0, 12)].join('|');
      if (s.seen.includes(fingerprint)) continue;
      const key = originKey(targetConversationId, n.taskId);
      const candidate = s.origins[key];
      const origin = candidate && (!candidate.workerConversationId || !n.workerConversationId ||
        candidate.workerConversationId === n.workerConversationId) ? candidate : undefined;
      if (origin) delete s.origins[key];
      const update: UpdateRecord = {
        id: `update-${randomUUID().slice(0, 12)}`,
        conversationId: targetConversationId,
        title: origin?.title ?? (n.summary.replace(/^Agent "(.*)" (completed|failed)$/, '$1') || 'Background task'),
        status: origin?.stopped && n.status === 'failed' ? 'cancelled' : n.status,
        needsInput: n.needsInput,
        report: n.report,
        depth: origin?.depth ?? 0,
        delivery: 'held',
        unread: true,
        createdAt: new Date().toISOString(),
      };
      s.seen.push(fingerprint);
      s.updates[update.id] = update;
      publishTasks.push({ taskId: n.taskId, title: update.title, conversationId: targetConversationId });
      if (wakesThread(update, origin?.mode ?? 'text')) deliveries.push({ id: update.id, conversationId: targetConversationId });
      count++;
    }
    return { accepted: count, targetConversationId };
  });
  // Retirement may have committed after this transaction but before its
  // side effects. In that case the updates have already moved or been removed;
  // never publish a late event or start delivery against the archived source.
  const currentRoute = retiredConversationDestination(conversationId);
  if (currentRoute === null ||
      (currentRoute !== undefined && currentRoute !== result.targetConversationId)) {
    return result.accepted;
  }
  // Notifications may now be removed from Letta's pending queue: persistence finished first.
  for (let i = 0; i < publishTasks.length; i++) {
    const { taskId, title, conversationId: targetConversationId } = publishTasks[i];
    safely(() => dependencies().publish(targetConversationId, { type: 'task', taskId, status: 'finished', title }));
  }
  for (const delivery of deliveries) void deliverWakingUpdate(delivery.conversationId, delivery.id).catch((error) =>
    console.error('[background] update delivery failed', error)
  );
  if (result.accepted) publishUnread(result.targetConversationId ?? conversationId);
  for (const id of publishTasks) {
    console.info(`[background] ${id.taskId} accepted in ${id.conversationId}`);
  }
  return result.accepted;
}

async function deliverWakingUpdate(conversationId: string, id: string): Promise<void> {
  const call = dependencies().isCallActive(conversationId);
  if (call) {
    const queued = await transact((s) => {
      const update = s.updates[id];
      if (update?.delivery !== 'held') return false;
      update.delivery = 'queued';
      return true;
    });
    if (queued && dependencies().announceUpdate(conversationId, id)) return;
    await transact((s) => {
      const update = s.updates[id];
      if (update?.delivery === 'queued') update.delivery = 'held';
    });
  }
  const claimed = await claim(conversationId, id, 'held');
  if (!claimed) return;
  try {
    const outcome = await dependencies().runUpdate(conversationId, {
      kind: 'update', modality: 'text', effort: 'low', text: '', updates: [claimed],
    });
    if (outcome.success) await completeDelivery(conversationId, id, claimed.deliveryToken!);
    else await rollbackDelivery(conversationId, id, claimed.deliveryToken!);
  } catch (error) {
    await rollbackDelivery(conversationId, id, claimed.deliveryToken!);
    throw error;
  }
}

async function onCallEnded(conversationId: string, pending: string[]): Promise<void> {
  await transact((s) => {
    for (const id of pending) {
      const update = s.updates[id];
      if (update?.conversationId === conversationId && update.delivery === 'queued') update.delivery = 'held';
    }
  });
  for (const id of pending) {
    const update = snapshot().updates[id];
    if (update?.conversationId === conversationId && update.delivery === 'held') {
      void deliverWakingUpdate(conversationId, id).catch((error) => console.error('[background] text fallback failed', error));
    }
  }
}

async function claim(conversationId: string, id: string, expected: UpdateRecord['delivery']): Promise<UpdateRecord | null> {
  return transact((s) => {
    const update = s.updates[id];
    if (!update || update.conversationId !== conversationId || update.delivery !== expected) return null;
    update.deliveryFrom = expected as 'held' | 'queued';
    update.delivery = 'inflight';
    update.deliveryToken = randomUUID();
    return structuredClone(update);
  });
}

/** Claim a queued voice update before generating its spoken response. */
export async function claimQueuedUpdate(conversationId: string, id: string): Promise<UpdateRecord | null> {
  return claim(conversationId, id, 'queued');
}

/** Backwards-compatible name; this now claims rather than prematurely delivering. */
export const takeQueuedUpdate = claimQueuedUpdate;

/** Held updates are claimed durably and must be completed or rolled back by the caller. */
export async function takeHeldUpdates(conversationId: string): Promise<UpdateRecord[]> {
  return transact((s) => {
    const held = Object.values(s.updates).filter((u) => u.conversationId === conversationId && u.delivery === 'held')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const update of held) {
      update.delivery = 'inflight';
      update.deliveryToken = randomUUID();
    }
    return structuredClone(held);
  });
}

export async function completeDelivery(conversationId: string, id: string, token: string): Promise<boolean> {
  const changed = await transact((s) => {
    const update = s.updates[id];
    if (!update || update.conversationId !== conversationId || update.delivery !== 'inflight' || update.deliveryToken !== token) return false;
    update.delivery = 'delivered';
    delete update.deliveryToken;
    delete update.deliveryFrom;
    return true;
  });
  if (changed) publishUnread(conversationId);
  return changed;
}

export async function rollbackDelivery(conversationId: string, id: string, token: string): Promise<boolean> {
  return transact((s) => {
    const update = s.updates[id];
    if (!update || update.conversationId !== conversationId || update.delivery !== 'inflight' || update.deliveryToken !== token) return false;
    update.delivery = update.deliveryFrom === 'queued' && dependencies().isCallActive(conversationId) ? 'queued' : 'held';
    delete update.deliveryToken;
    delete update.deliveryFrom;
    return true;
  });
}

/** Acknowledgment is idempotent; unread changes only after completed delivery. */
export async function markRead(conversationId: string, ids: readonly string[]): Promise<void> {
  const changed = await transact((s) => {
    let any = false;
    for (const id of ids) {
      const update = s.updates[id];
      if (update?.conversationId === conversationId && update.delivery !== 'inflight' && update.unread) {
        update.unread = false;
        any = true;
      }
    }
    return any;
  });
  if (changed) {
    safely(() => dependencies().publish(conversationId, { type: 'updates_changed' }));
    publishUnread(conversationId);
  }
}

/** Retire background work when a conversation is archived or its history is forked. */
export async function retireConversation(conversationId: string, destinationId?: string): Promise<void> {
  const migrated: Array<{ taskId: string; title: string }> = [];
  await transact((s) => {
    const destination = destinationId ?? null;
    // Keep aliases one hop long when a fork is forked again.
    for (const prior of Object.values(s.retired)) {
      if (prior.destinationConversationId === conversationId) prior.destinationConversationId = destination;
    }
    s.retired[conversationId] = { destinationConversationId: destination, retiredAt: new Date().toISOString() };
    for (const [key, origin] of Object.entries(s.origins)) {
      if (origin.conversationId !== conversationId) continue;
      if (destinationId) migrated.push({ taskId: origin.taskId, title: origin.title });
      delete s.origins[key];
      if (destinationId) {
        origin.conversationId = destinationId;
        s.origins[originKey(destinationId, origin.taskId)] = origin;
      }
    }
    for (const [id, update] of Object.entries(s.updates)) {
      if (update.conversationId !== conversationId) continue;
      if (!destinationId) {
        delete s.updates[id];
        continue;
      }
      update.conversationId = destinationId;
      if (update.delivery === 'queued' || update.delivery === 'inflight') update.delivery = 'held';
      delete update.deliveryToken;
      delete update.deliveryFrom;
    }
  });
  for (const task of migrated) safely(() => dependencies().publish(destinationId!, {
    type: 'task', taskId: task.taskId, status: 'running', title: task.title,
  }));
  if (destinationId) publishUnread(destinationId);
}

/** The durable routing decision for callbacks that name a retired source. */
export function retiredConversationDestination(conversationId: string): string | null | undefined {
  const retired = snapshot().retired[conversationId];
  return retired ? retired.destinationConversationId : undefined;
}

function resolveRetired(
  retired: BackgroundState['retired'],
  conversationId: string
): string | null | undefined {
  let current = conversationId;
  const visited = new Set<string>();
  while (retired[current]) {
    if (visited.has(current)) return null;
    visited.add(current);
    const destination = retired[current].destinationConversationId;
    if (destination === null) return null;
    current = destination;
  }
  return current === conversationId ? undefined : current;
}

export function unreadCount(conversationId: string): number {
  return Object.values(snapshot().updates).filter((u) => u.conversationId === conversationId && u.unread).length;
}

function publishUnread(conversationId: string): void {
  safely(() => dependencies().publish(conversationId, { type: 'updates_changed' }));
  safely(() => dependencies().publishList({ type: 'unread', conversationId, unread: unreadCount(conversationId) }));
}

function safely(operation: () => void): void {
  try {
    operation();
  } catch (error) {
    console.error('[background] event delivery failed', error);
  }
}

export function withUpdates(conversationId: string, rows: ChatMessage[]): ChatMessage[] {
  const updates = snapshot().updates;
  const marked = rows.map((row) => row.role === 'event' && row.updateId && updates[row.updateId]?.unread
    ? { ...row, unread: true } : row);
  const held = Object.values(updates).filter((u) => u.conversationId === conversationId && u.delivery !== 'delivered')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((u): ChatMessage => ({
      id: `pending-update:${u.id}`, role: 'event', kind: 'task_result',
      text: dependencies().updateLabel(u.title, u.status, u.needsInput), updateId: u.id,
      detail: u.report, unread: u.unread, createdAt: u.createdAt,
    }));
  return [...marked, ...held];
}

/** The depth of work started while answering these updates. */
export function depthAfter(updates: readonly UpdateRecord[]): number {
  return updates.length ? Math.max(...updates.map((u) => u.depth)) + 1 : 0;
}
