import { MemoryStore, type RecallResult } from '@artemis/memory';

/**
 * Memory disabled (no HINDSIGHT_URL): recalls nothing, retains nothing, never blocks a turn.
 * Healthy, because disabled is a valid configuration and not a degraded service.
 */
export class NoopMemoryStore extends MemoryStore {
  async ensureReady(): Promise<void> {}

  async retain(): Promise<{ operationId: string }> {
    return { operationId: 'disabled' };
  }

  async recall(): Promise<RecallResult> {
    return { facts: [] };
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}
