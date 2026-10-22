import type { MemoryFact, TranscriptTurn } from './store.ts';

/** `Speaker (ISO time): text` lines, one per turn (Hindsight's recommended conversation format). */
export function formatTranscript(turns: readonly TranscriptTurn[]): string {
  return turns.map((turn) => `${turn.speaker} (${turn.at}): ${turn.text.trim()}`).join('\n');
}

/**
 * The `<recalled-memories>` block placed in the user-turn envelope (after the
 * cached prefix). Facts already injected earlier in the conversation are
 * filtered out by the caller. Returns '' when nothing is left.
 */
export function renderRecalledMemories(facts: readonly MemoryFact[]): string {
  if (facts.length === 0) return '';
  const lines = facts.map((fact) => `- [${fact.type}] ${fact.text}${dateNote(fact)}`);
  return ['<recalled-memories>', ...lines, '</recalled-memories>'].join('\n');
}

function dateNote(fact: MemoryFact): string {
  if (fact.occurredAt) return ` (occurred ${dateOnly(fact.occurredAt)})`;
  if (fact.mentionedAt) return ` (mentioned ${dateOnly(fact.mentionedAt)})`;
  return '';
}

/** Keeps the calendar date of an ISO timestamp; other values are kept as given. */
function dateOnly(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? value;
}
