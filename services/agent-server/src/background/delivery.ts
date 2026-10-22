import { notImplemented } from '@artemis/core';
import type { ChatMessage } from '@artemis/contracts/chat-types';
import type { BackgroundUpdateRecord, TaskRecord } from '@artemis/storage';

/**
 * Turns finished tasks into updates for the main agent (modernized
 * background/service.ts; inputs are first-party task outcomes, no text parsing):
 *
 * taskFinished(task):
 *   create update (delivery `held`, unread) -> publish `task {finished}`,
 *   `updates_changed`, list `unread`;
 *   if `wakesThread(update, task.originMode)`:
 *     call active  -> `queued` + announce to the voice agent (control channel);
 *     else         -> main worker `submit({kind:'update', modality:'text', effort:'low', text:''})`
 *                     (spawns the worker if it was reaped).
 *   otherwise it stays `held` and rides along with the next turn.
 *
 * Turns claim updates with a token (held/queued -> inflight) and complete
 * (-> delivered) or roll back. Call end: unspoken `queued` -> `held` + wake.
 */
export abstract class BackgroundDeliveryService {
  abstract taskFinished(task: TaskRecord): Promise<BackgroundUpdateRecord>;
  abstract claimHeld(conversationId: string): Promise<{ token: string; updates: BackgroundUpdateRecord[] }>;
  abstract claimQueued(conversationId: string, updateId: string): Promise<{ token: string; update: BackgroundUpdateRecord } | null>;
  abstract complete(token: string, turnId: string): Promise<void>;
  abstract rollback(token: string): Promise<void>;
  abstract markRead(conversationId: string, ids: string[]): Promise<number>;
  abstract unreadCount(conversationId: string): Promise<number>;
  abstract callEnded(conversationId: string, pendingUpdateIds: string[]): Promise<void>;
  /** Event rows (`role:'event'`) for history projection, incl. not-yet-delivered updates. */
  abstract eventRows(conversationId: string): Promise<ChatMessage[]>;
}

export function createBackgroundDeliveryService(): BackgroundDeliveryService {
  return notImplemented('createBackgroundDeliveryService');
}
