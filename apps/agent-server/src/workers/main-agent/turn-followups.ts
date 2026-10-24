import { type Logger, errorMessage } from '@artemis/core';
import type { RecalledMemory, Storage, TurnRecord } from '@artemis/storage';
import type { MemoryCoordinator } from '../../memory/coordinator.ts';
import type { TitleService } from '../../titles/title-service.ts';
import { updateQuery } from './envelope.ts';
import type { TurnState } from './turn-state.ts';
import { safely } from '../safely.ts';
import type { TurnSubmission } from '../../turns/types.ts';

export interface TurnFollowupsDeps {
  storage: Pick<Storage, 'turns' | 'conversations'>;
  memory: MemoryCoordinator;
  titles: TitleService;
  logger: Logger;
}

/**
 * What a turn does with memory and titles around the answer: activation when the
 * turn opens, recall before the answer, and the bookkeeping and first-message title
 * request when it completes. Memory failures never fail a turn.
 */
export class TurnFollowups {
  constructor(private readonly deps: TurnFollowupsDeps) {}

  /** Memory activation: the coordinator swaps the last active conversation. */
  async activate(conversationId: string): Promise<void> {
    const { memory, logger } = this.deps;
    await safely(logger, 'memory activation', () => memory.conversationActivated(conversationId));
  }

  /**
   * Recall before every answer (user, voice and update turns). The coordinator
   * applies its timeout, dedups against the conversation and writes the trace;
   * a failure here still means no memories, never a failed turn.
   */
  async recall(conversationId: string, state: TurnState): Promise<RecalledMemory[]> {
    const { memory, logger } = this.deps;
    const sub = state.submission;
    const query = sub.kind === 'update' ? updateQuery(state.claimed) : sub.text;
    try {
      return await memory.recallFor({
        conversationId,
        turnId: state.turnId,
        modality: sub.modality,
        effort: sub.effort ?? null,
        query,
        signal: state.signal,
      });
    } catch (error) {
      logger.warn('recall skipped', { turnId: state.turnId, error: errorMessage(error) });
      return [];
    }
  }

  /** After a turn finished: memory turn bookkeeping, and the title request on the first user message. */
  async completed(conversationId: string, turnId: string, submission: TurnSubmission): Promise<void> {
    const { storage, memory, titles, logger } = this.deps;
    const record: TurnRecord | null = await storage.turns.get(turnId);
    if (record) await safely(logger, 'memory turn bookkeeping', () => memory.turnCompleted(record));
    const conversation = await storage.conversations.get(conversationId);
    if (submission.kind === 'user' && conversation && !conversation.title && submission.text.trim()) titles.request(conversationId, submission.text);
  }
}
