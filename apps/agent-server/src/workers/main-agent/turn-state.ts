import type { BackgroundUpdateRecord } from '@artemis/storage';
import type { TurnSubmission } from '../types.ts';

/** Per-turn bookkeeping shared by the steps of one turn. */
export interface TurnState {
  turnId: string;
  submission: TurnSubmission;
  signal: AbortSignal;
  controller: AbortController;
  /** Claim of the held / queued updates this turn delivers. */
  token: string | null;
  claimed: BackgroundUpdateRecord[];
  /** The turn row exists (so it must be finished on failure). */
  recorded: boolean;
  finished: boolean;
}
