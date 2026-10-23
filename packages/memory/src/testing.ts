// Test-only entry point (`@artemis/memory/testing`). Production code must not import it.
import { type MemoryFact, MemoryStore, type RecallRequest, type RecallResult, type RetainRequest } from './store.ts';

/** In-memory `MemoryStore` with scriptable retain failures and recall behaviour. */
export class FakeMemoryStore extends MemoryStore {
  readonly retains: RetainRequest[] = [];
  readonly recalls: RecallRequest[] = [];
  facts: MemoryFact[] = [];
  retainFailures = 0;
  /** `hang` never answers (until the caller aborts). */
  recallMode: 'facts' | 'hang' = 'facts';

  async ensureReady(): Promise<void> {}

  async retain(request: RetainRequest): Promise<{ operationId: string }> {
    if (this.retainFailures > 0) {
      this.retainFailures -= 1;
      throw new Error('hindsight unavailable');
    }
    this.retains.push(request);
    return { operationId: request.operationId };
  }

  async recall(request: RecallRequest, signal?: AbortSignal): Promise<RecallResult> {
    this.recalls.push(request);
    if (this.recallMode === 'hang') {
      return new Promise<RecallResult>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted by caller')));
      });
    }
    return { facts: this.facts };
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}
