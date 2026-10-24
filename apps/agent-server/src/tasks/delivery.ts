import type { Clock, Logger } from '@artemis/core';
import { errorMessage, prefixedId, uuid } from '@artemis/core';
import type { ChatMessage } from '@artemis/contracts/chat-types';
import type { BackgroundUpdateRecord, Storage, TaskRecord } from '@artemis/storage';
import type { ConversationEventHub } from '../events/hub.ts';
import type { CallSessions } from '../calls/call-sessions.ts';
import { isoAt } from '../util/time.ts';
import { taskUpdateLabel } from './labels.ts';
import { wakesThread } from './policy.ts';

/**
 * Turns finished tasks into updates for the main agent (inputs are first-party task outcomes, no text parsing):
 *
 * taskFinished(task):
 *   create update (delivery `held`, unread) -> publish `updates_changed` and the
 *   unread count; if `wakesThread(update, task.originMode)`:
 *     call active  -> `queued` + announce to the voice agent (control channel);
 *                     not announced -> back to `held` and wake;
 *     else         -> wake the conversation (its main worker submits an update turn,
 *                     respawning it if it was reaped).
 *   otherwise it stays `held` and rides along with the next turn.
 *
 * Turns claim updates with a token (held/queued -> inflight) and complete
 * (-> delivered) or roll back. Call end: unspoken `queued` -> `held` + wake.
 */
export interface BackgroundDeliveryService {
  /** `null` when the conversation is archived (nothing is recorded or woken). */
  taskFinished(task: TaskRecord): Promise<BackgroundUpdateRecord | null>;
  claimHeld(conversationId: string): Promise<{ token: string; updates: BackgroundUpdateRecord[] }>;
  claimQueued(conversationId: string, updateId: string): Promise<{ token: string; update: BackgroundUpdateRecord } | null>;
  complete(conversationId: string, token: string, turnId: string): Promise<void>;
  rollback(conversationId: string, token: string): Promise<void>;
  markRead(conversationId: string, ids: string[]): Promise<number>;
  unreadCount(conversationId: string): Promise<number>;
  /** Never rejects: a failure is logged at error level. */
  callEnded(conversationId: string, pendingUpdateIds: string[]): Promise<void>;
  /** Event rows (`role:'event'`) of the updates not yet delivered (held, queued, inflight). */
  eventRows(conversationId: string): Promise<ChatMessage[]>;
}

export interface BackgroundDeliveryDeps {
  storage: Storage;
  hub: ConversationEventHub;
  calls: CallSessions;
  clock: Clock;
  logger: Logger;
  /** Starts an update turn for the conversation (never throws; the supervisor logs failures). */
  wake: (conversationId: string) => void;
}

export function createBackgroundDelivery(deps: BackgroundDeliveryDeps): BackgroundDeliveryService {
  return new StorageBackgroundDelivery(deps);
}

class StorageBackgroundDelivery implements BackgroundDeliveryService {
  constructor(private readonly deps: BackgroundDeliveryDeps) {}

  async taskFinished(task: TaskRecord): Promise<BackgroundUpdateRecord | null> {
    const { storage, calls, logger } = this.deps;
    // A task cancelled by archive still ends here: an archived conversation records and wakes nothing.
    if (!(await this.live(task.conversationId))) return null;
    const status = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' ? task.status : 'failed';
    const durationMs = task.endedAt ? Math.max(0, Date.parse(task.endedAt) - Date.parse(task.startedAt)) : null;
    const update = await storage.updates.create({
      id: uuid(),
      conversationId: task.conversationId,
      taskId: task.id,
      title: task.title,
      status,
      needsInput: task.needsInput,
      report: task.report ?? '',
      durationMs,
      depth: task.depth,
      delivery: 'held',
      unread: true,
      createdAt: this.now(),
    });
    this.changed(task.conversationId);

    if (!wakesThread({ status, needsInput: task.needsInput, depth: task.depth }, task.originMode)) return update;
    if (calls.active(task.conversationId)) {
      const queued = await storage.updates.queue(update.id);
      if (queued && calls.announceUpdate(task.conversationId, update.id)) return update;
      if (queued) await storage.updates.unqueue(task.conversationId, [update.id]);
      this.changed(task.conversationId);
    }
    logger.debug('waking conversation for a finished task', { conversationId: task.conversationId, taskId: task.id });
    this.deps.wake(task.conversationId);
    return update;
  }

  async claimHeld(conversationId: string): Promise<{ token: string; updates: BackgroundUpdateRecord[] }> {
    const token = prefixedId('dlv');
    const updates = await this.deps.storage.updates.claimHeld(conversationId, token);
    if (updates.length) this.changed(conversationId);
    return { token, updates };
  }

  async claimQueued(conversationId: string, updateId: string): Promise<{ token: string; update: BackgroundUpdateRecord } | null> {
    const existing = await this.deps.storage.updates.get(updateId);
    if (!existing || existing.conversationId !== conversationId || existing.delivery !== 'queued') return null;
    const token = prefixedId('dlv');
    const update = await this.deps.storage.updates.claimQueued(updateId, token);
    if (!update) return null;
    this.changed(conversationId);
    return { token, update };
  }

  async complete(conversationId: string, token: string, turnId: string): Promise<void> {
    await this.deps.storage.updates.complete(token, turnId, this.now());
    this.changed(conversationId);
  }

  async rollback(conversationId: string, token: string): Promise<void> {
    await this.deps.storage.updates.rollback(token);
    this.changed(conversationId);
  }

  async markRead(conversationId: string, ids: string[]): Promise<number> {
    const count = await this.deps.storage.updates.markRead(conversationId, ids, this.now());
    this.changed(conversationId);
    return count;
  }

  unreadCount(conversationId: string): Promise<number> {
    return this.deps.storage.updates.unreadCount(conversationId);
  }

  async callEnded(conversationId: string, pendingUpdateIds: string[]): Promise<void> {
    try {
      if (!(await this.live(conversationId))) return;
      const unqueued = await this.deps.storage.updates.unqueue(conversationId, pendingUpdateIds);
      this.changed(conversationId);
      if (unqueued > 0) this.deps.wake(conversationId);
    } catch (error) {
      // Call end runs detached from any request: a failure is logged, never thrown.
      this.deps.logger.error('call-end delivery failed', { conversationId, error: errorMessage(error) });
    }
  }

  async eventRows(conversationId: string): Promise<ChatMessage[]> {
    const updates = await this.deps.storage.updates.listByConversation(conversationId, {
      delivery: ['held', 'queued', 'inflight'],
    });
    return updates.map(updateEventRow);
  }

  private now(): string {
    return isoAt(this.deps.clock.now());
  }

  /** False for archived (or unknown) conversations: no updates, no wake-ups. */
  private async live(conversationId: string): Promise<boolean> {
    return Boolean(await this.deps.storage.conversations.get(conversationId));
  }

  /** Read state and delivery changed: live event plus the unread count for the list. */
  private changed(conversationId: string): void {
    void this.announce(conversationId).catch((error: unknown) => {
      this.deps.logger.error('updates announcement failed', { conversationId, error: String(error) });
    });
  }

  private async announce(conversationId: string): Promise<void> {
    const { hub, storage } = this.deps;
    hub.publish(conversationId, { type: 'updates_changed' });
    const unread = await storage.updates.unreadCount(conversationId);
    hub.publishList({ type: 'unread', conversationId, unread });
  }
}

/** The `event` row of an update in the chat history and in live events. */
export function updateEventRow(update: BackgroundUpdateRecord): ChatMessage {
  return {
    id: update.id,
    role: 'event',
    kind: 'task_result',
    text: taskUpdateLabel(update),
    updateId: update.id,
    taskId: update.taskId,
    status: update.status,
    ...(update.durationMs !== null ? { durationMs: update.durationMs } : {}),
    detail: update.report,
    unread: update.unread,
    createdAt: update.createdAt,
  };
}
