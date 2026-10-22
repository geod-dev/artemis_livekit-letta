import { notImplemented } from '@artemis/core';
import type { RecalledMemory, TurnRecord } from '@artemis/storage';

/**
 * Applies the memory rules (architecture.md#memory-coordinator):
 * - `conversationActivated(id)` on every accepted user message: swap
 *   `app_state.last_active_conversation_id`; when it changed, flush the
 *   previous conversation's unanalyzed completed turns.
 * - `recallFor(turn)` before EVERY assistant answer (user, voice, update turns):
 *   budget = `recallBudget(modality, effort)`, timeout voice 1.5 s / text 4 s
 *   (on timeout or error: no memories, the turn proceeds), drop memories
 *   already injected in this conversation (`conversation_recalls`).
 * - `turnCompleted(turn)`: when the conversation has >= `retainEvery` (3)
 *   unanalyzed completed user turns, retain them (plus interleaved update turns)
 *   asynchronously and mark them analyzed.
 * Retention goes through the `memory_retentions` outbox (retry with backoff,
 * idempotent `operation_id`); memory failures never fail a turn.
 */
export abstract class MemoryCoordinator {
  abstract conversationActivated(conversationId: string): Promise<void>;
  abstract recallFor(input: {
    conversationId: string;
    turnId: string;
    modality: 'text' | 'voice';
    effort?: TurnRecord['effort'];
    query: string;
    signal?: AbortSignal;
  }): Promise<RecalledMemory[]>;
  abstract turnCompleted(turn: TurnRecord): Promise<void>;
  abstract flush(conversationId: string, reason: 'switch' | 'shutdown'): Promise<void>;
  /** Outbox pump: submit pending retentions. */
  abstract start(): void;
  abstract stop(): Promise<void>;
}

export function createMemoryCoordinator(): MemoryCoordinator {
  return notImplemented('createMemoryCoordinator');
}
