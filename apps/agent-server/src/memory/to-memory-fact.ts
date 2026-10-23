import type { MemoryFact } from '@artemis/memory';
import type { RecalledMemory } from '@artemis/storage';

/** A recalled memory as the memory renderer takes it. */
export function toMemoryFact(memory: RecalledMemory): MemoryFact {
  return { id: memory.id, text: memory.text, type: memory.type, ...(memory.date ? { occurredAt: memory.date } : {}) };
}
