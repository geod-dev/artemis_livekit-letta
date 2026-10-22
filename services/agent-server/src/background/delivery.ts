import type { Clock, Logger } from '@artemis/core';
import { prefixedId } from '@artemis/core';
import type { ChatMessage } from '@artemis/contracts/chat-types';
import type { BackgroundUpdateRecord, Storage, TaskRecord } from '@artemis/storage';
import type { ConversationEventHub } from '../events/hub.ts';
import type { CallSessions } from '../calls/call-sessions.ts';
import { updateLabel } from '../turns/envelope.ts';
import { wakesThread } from './policy.ts';

/**
 * Turns finished tasks into updates for the main agent (modernized
 * background/service.ts; inputs are first-party task outcomes, no text parsing):
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
export abstract class BackgroundDeliveryService {
  /** `null` when the conversation is archived (nothing is recorded or woken). */
  abstract taskFinished(task: TaskRecord): Promise<BackgroundUpdateRecord | null>;
  abstract claimHeld(conversationId: string): Promise<{ token: string; updates: BackgroundUpdateRecord[] }>;
  abstract claimQueued(conversationId: string, updateId: string): Promise<{ token: string; update: BackgroundUpdateRecord } | null>;
  abstract complete(conversationId: string, token: string, turnId: string): Promise<void>;
  abstract rollback(conversationId: string, token: string): Promise<void>;
  abstract markRead(conversationId: string, ids: string[]): Promise<number>;
  abstract unreadCount(conversationId: string): Promise<number>;
  abstract callEnded(conversationId: string, pendingUpdateIds: string[]): Promise<void>;
  /** Event rows (`role:'event'`) for history projection, incl. not-yet-delivered updates. */
  abstract eventRows(conversationId: string): Promise<ChatMessage[]>;
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

export class StorageBackgroundDeliveryService extends BackgroundDeliveryService {
  constructor(private readonly deps: BackgroundDeliveryDeps) {
    super();
  }

  async taskFinished(task: TaskRecord): Promise<BackgroundUpdateRecord | null> {
    const { storage, calls, logger } = this.deps;
    // A task cancelled by archive still ends here: an archived conversation records and wakes nothing.
    if (!(await this.live(task.conversationId))) return null;
    const status = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' ? task.status : 'failed';
    const durationMs = task.endedAt ? Math.max(0, Date.parse(task.endedAt) - Date.parse(task.startedAt)) : null;
    const update = await storage.updates.create({
      id: prefixedId('upd'),
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
    if (!(await this.live(conversationId))) return;
    const unqueued = await this.deps.storage.updates.unqueue(conversationId, pendingUpdateIds);
    this.changed(conversationId);
    if (unqueued > 0) this.deps.wake(conversationId);
  }

  async eventRows(conversationId: string): Promise<ChatMessage[]> {
    const updates = await this.deps.storage.updates.listByConversation(conversationId);
    return updates.map(updateEventRow);
  }

  private now(): string {
    return new Date(this.deps.clock.now()).toISOString();
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
    text: updateLabel(update),
    updateId: update.id,
    taskId: update.taskId,
    status: update.status,
    ...(update.durationMs !== null ? { durationMs: update.durationMs } : {}),
    detail: update.report,
    unread: update.unread,
    createdAt: update.createdAt,
  };
}
