import type { TurnMode } from '@artemis/contracts/chat-types';

/**
 * Whether a finished task wakes the conversation that started it (unchanged
 * from backend/src/assistant/background/policy.ts):
 * - work stopped on purpose never wakes it;
 * - work started while answering an update (depth > 0) never wakes it;
 * - failures and requests for the user's input always wake it;
 * - successful work wakes it unless it was started in a short voice call.
 */
export function wakesThread(
  update: { status: 'completed' | 'failed' | 'cancelled'; needsInput: boolean; depth: number },
  originMode: TurnMode
): boolean {
  if (update.status === 'cancelled' || update.depth > 0) return false;
  if (update.status === 'failed' || update.needsInput) return true;
  return originMode !== 'voice-short';
}

/** Depth of tasks started by a turn delivering `updates`: one more than the deepest. */
export function depthAfter(updates: ReadonlyArray<{ depth: number }>): number {
  return updates.length ? Math.max(...updates.map((u) => u.depth)) + 1 : 0;
}
