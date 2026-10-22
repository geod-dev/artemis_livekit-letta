import { notImplemented } from '@artemis/core';
import type { MemoryFact, TranscriptTurn } from './store.ts';

/** `Speaker (ISO time): text` lines, one per turn (Hindsight's recommended conversation format). */
export function formatTranscript(_turns: readonly TranscriptTurn[]): string {
  return notImplemented('formatTranscript');
}

/**
 * The `<recalled-memories>` block placed in the user-turn envelope (after the
 * cached prefix). Facts already injected earlier in the conversation are
 * filtered out by the caller. Returns '' when nothing is left.
 */
export function renderRecalledMemories(_facts: readonly MemoryFact[]): string {
  return notImplemented('renderRecalledMemories');
}
