import type { LoopOutcome } from '@artemis/agent-loop';
import type { TurnUsage } from '@artemis/storage';

export type TurnStatus = 'completed' | 'failed' | 'cancelled';

/** The persisted status of a turn for a loop outcome (a step limit counts as a failure). */
export function turnStatus(outcome: LoopOutcome): TurnStatus {
  if (outcome.status === 'completed') return 'completed';
  return outcome.status === 'cancelled' ? 'cancelled' : 'failed';
}

/** The error text of a failed turn; undefined for the other statuses. */
export function turnError(outcome: LoopOutcome, status: TurnStatus): string | undefined {
  if (status !== 'failed') return undefined;
  return outcome.error ?? (outcome.status === 'max_steps' ? 'The step limit was reached' : 'The turn failed');
}

/** Loop usage as stored on the turn row (missing cache and reasoning counts are zero). */
export function turnUsage(usage: LoopOutcome['usage']): TurnUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    steps: usage.steps,
    lastContextTokens: usage.lastContextTokens,
  };
}
