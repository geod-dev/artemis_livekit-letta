import { notImplemented } from '@artemis/core';
import { MemoryStore, type RecallRequest, type RecallResult, type RetainRequest } from '../store.ts';

export interface HindsightMemoryOptions {
  /** `http://hindsight:8888` */
  baseUrl: string;
  /** Sent as `Authorization: Bearer` (ApiKeyTenantExtension). */
  apiKey?: string;
  /** One bank for the single user, e.g. `artemis`. */
  bankId: string;
  /** Bank missions applied by `ensureReady` (PUT /v1/default/banks/{bank}). */
  retainMission?: string;
  reflectMission?: string;
}

/**
 * Hindsight through `@vectorize-io/hindsight-client`:
 * - retain -> `retainBatch(bank, [{content: formatTranscript(turns), timestamp, context, metadata,
 *   document_id, update_mode: 'append', tags}], {async: true, operationId})`.
 * - recall -> `recall(bank, query, {budget, maxTokens, queryTimestamp, preferObservations: true,
 *   types: ['world','experience','observation']})`.
 * The memory LLM (claude-haiku-5-5, effort medium) is configured on the Hindsight server, not here.
 */
export class HindsightMemoryStore extends MemoryStore {
  constructor(readonly options: HindsightMemoryOptions) {
    super();
  }

  ensureReady(): Promise<void> {
    return notImplemented('HindsightMemoryStore.ensureReady');
  }
  retain(_request: RetainRequest, _signal?: AbortSignal): Promise<{ operationId: string }> {
    return notImplemented('HindsightMemoryStore.retain');
  }
  recall(_request: RecallRequest, _signal?: AbortSignal): Promise<RecallResult> {
    return notImplemented('HindsightMemoryStore.recall');
  }
  healthy(): Promise<boolean> {
    return notImplemented('HindsightMemoryStore.healthy');
  }
}
