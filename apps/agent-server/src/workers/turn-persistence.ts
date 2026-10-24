import { type Clock, type Logger, uuid } from '@artemis/core';
import type { ChatMessage } from '@artemis/contracts/chat-types';
import type { UserContent } from '@artemis/llm';
import type { Storage, TurnUsage, UserTurnEnvelope } from '@artemis/storage';
import type { ConversationEventHub } from '../events/hub.ts';
import type { BackgroundDeliveryService } from '../tasks/delivery.ts';
import { isoAt } from '../util/time.ts';
import { settleClaim } from './main-agent/claims.ts';
import { echoRows } from './main-agent/envelope.ts';
import type { TurnStatus } from './main-agent/outcome.ts';
import type { TurnState } from './main-agent/turn-state.ts';
import { safely } from './safely.ts';

export interface TurnPersistenceDeps {
  storage: Pick<Storage, 'turns' | 'messages' | 'conversations'>;
  hub: ConversationEventHub;
  delivery: BackgroundDeliveryService;
  clock: Clock;
  logger: Logger;
}

/** How a turn ended, as stored on its row. */
export interface TurnResult {
  status: TurnStatus;
  error?: string;
  usage: TurnUsage;
  model: string;
}

/**
 * The durable rows of one turn and the live events that mirror them: the running
 * turn row, the user message with its echo rows, and the finish (status, usage,
 * delivery settlement, `context_usage`, `turn_end`).
 */
export class TurnPersistence {
  constructor(private readonly deps: TurnPersistenceDeps) {}

  /** Persists the running turn row, publishes its start, and touches the conversation. */
  async open(state: TurnState, conversationId: string): Promise<void> {
    const { storage, hub, clock } = this.deps;
    const { turnId, submission: sub } = state;
    const started = await storage.turns.create({
      id: turnId,
      conversationId,
      kind: sub.kind,
      modality: sub.modality,
      mode: sub.mode,
      effort: sub.effort ?? null,
      status: 'running',
      clientMessageId: sub.clientMessageId ?? null,
      model: null,
      startedAt: isoAt(clock.now()),
    });
    state.recorded = true;
    hub.publish(conversationId, { type: 'turn_start', turnId, modality: sub.modality });
    await storage.conversations.touch(conversationId, started.startedAt);
  }

  /** Stores the user message verbatim and publishes its live rows (the echo). */
  async appendUserMessage(state: TurnState, conversationId: string, envelope: UserTurnEnvelope, content: UserContent[]): Promise<void> {
    const userMessage = await this.deps.storage.messages.append({
      id: uuid(),
      conversationId,
      taskId: null,
      turnId: state.turnId,
      role: 'user',
      content,
      envelope,
      provider: null,
      model: null,
      providerMessageId: null,
      stopReason: null,
      usage: null,
      timings: null,
    });
    this.echo(state, conversationId, userMessage.id, userMessage.createdAt);
  }

  /** Persists the turn's status and usage, settles its claim, and publishes the end events. */
  async finish(state: TurnState, conversationId: string, result: TurnResult): Promise<void> {
    const { storage, hub, delivery, clock } = this.deps;
    const { turnId } = state;
    await storage.turns.finish(turnId, {
      status: result.status,
      error: result.error ?? null,
      usage: result.usage,
      model: result.model,
      endedAt: isoAt(clock.now()),
    });
    state.finished = true;
    await settleClaim(state, conversationId, delivery, result.status === 'completed');
    hub.publish(conversationId, { type: 'context_usage' });
    hub.publish(conversationId, {
      type: 'turn_end',
      turnId,
      success: result.status === 'completed',
      ...(result.error ? { error: result.error } : {}),
    });
  }

  /** A turn that threw: its row is failed, its claim rolled back, and the end event published. */
  async abandon(state: TurnState, conversationId: string, message: string): Promise<void> {
    const { storage, hub, delivery, clock, logger } = this.deps;
    const { turnId } = state;
    if (state.recorded && !state.finished) {
      await safely(logger, 'turn failure record', () =>
        storage.turns.finish(turnId, { status: 'failed', error: message, usage: null, model: null, endedAt: isoAt(clock.now()) })
      );
      state.finished = true;
      hub.publish(conversationId, { type: 'turn_end', turnId, success: false, error: message });
    }
    await safely(logger, 'delivery rollback', () => settleClaim(state, conversationId, delivery, false));
  }

  /** Live rows of this turn: the updates it delivers and the user's message. */
  private echo(state: TurnState, conversationId: string, messageId: string, createdAt: string): void {
    const rows: ChatMessage[] = echoRows(state, messageId, createdAt);
    for (const row of rows) this.deps.hub.publish(conversationId, { type: 'message', turnId: state.turnId, message: row });
  }
}
