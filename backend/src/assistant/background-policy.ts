/**
 * Whether a finished background task wakes the conversation that started it.
 * Pure so it can be unit tested.
 *
 * - Work stopped on purpose never wakes it.
 * - Work started while answering an update never wakes it either: an update
 *   cannot start a chain of further updates.
 * - Failures and requests for the user's input always wake it.
 * - Successful work wakes it unless it was started in a short voice call;
 *   that result waits for the conversation's next turn.
 */
import type { TurnMode } from '../chat-types';
import type { BackgroundUpdate } from './messages';

export function wakesThread(
  update: Pick<BackgroundUpdate, 'status' | 'needsInput'> & { depth: number },
  originMode: TurnMode
): boolean {
  if (update.status === 'cancelled' || update.depth > 0) return false;
  if (update.status === 'failed' || update.needsInput) return true;
  return originMode !== 'voice-short';
}
