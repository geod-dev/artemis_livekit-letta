import type { BackgroundDeliveryService } from '../../tasks/delivery.ts';
import type { TurnState } from './turn-state.ts';

/** Takes the updates this turn delivers: the caller's claim, or every held update of a text turn. */
export async function claimUpdates(state: TurnState, conversationId: string, delivery: BackgroundDeliveryService): Promise<void> {
  const sub = state.submission;
  if (sub.updates) {
    state.claimed = sub.updates;
    state.token = sub.deliveryToken ?? null;
  } else if (sub.modality === 'text') {
    const claim = await delivery.claimHeld(conversationId);
    state.claimed = claim.updates;
    state.token = claim.token;
  }
}

/** Completes the claim (the turn delivered its updates) or rolls it back. A claim is settled once. */
export async function settleClaim(state: TurnState, conversationId: string, delivery: BackgroundDeliveryService, delivered: boolean): Promise<void> {
  if (!state.token) return;
  if (delivered) await delivery.complete(conversationId, state.token, state.turnId);
  else await delivery.rollback(conversationId, state.token);
  state.token = null;
}
