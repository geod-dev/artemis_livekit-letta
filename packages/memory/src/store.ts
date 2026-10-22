/**
 * Long-term memory behind one abstraction. `HindsightMemoryStore`
 * (`@artemis/memory/hindsight`) is the only implementation; tests use a fake.
 */

export type RecallBudget = 'low' | 'mid' | 'high';

export interface TranscriptTurn {
  /** `User`, the assistant's name, or `Background task`. */
  speaker: string;
  at: string;
  text: string;
}

export interface RetainRequest {
  /** Stable per conversation (`conversation:<id>`); appended to (`update_mode: append`). */
  documentId: string;
  /** Idempotency key (Hindsight `operation_id`), reused on retries. */
  operationId: string;
  turns: TranscriptTurn[];
  /** Describes the speakers (drives world vs experience attribution). */
  context: string;
  /** ISO timestamp anchoring relative dates: the last turn's time. */
  timestamp: string;
  metadata?: Record<string, string>;
  tags?: string[];
}

export interface RecallRequest {
  query: string;
  budget: RecallBudget;
  maxTokens: number;
  /** Anchor for "last week" etc. */
  queryTimestamp: string;
  tags?: string[];
}

export interface MemoryFact {
  id: string;
  text: string;
  type: 'world' | 'experience' | 'observation';
  occurredAt?: string;
  mentionedAt?: string;
}

export interface RecallResult {
  facts: MemoryFact[];
}

export abstract class MemoryStore {
  /** Idempotent setup (create/update the bank and its missions). */
  abstract ensureReady(): Promise<void>;
  /** Asynchronous ingestion: resolves once accepted (not processed). */
  abstract retain(request: RetainRequest, signal?: AbortSignal): Promise<{ operationId: string }>;
  /** Synchronous retrieval; callers apply their own timeout via `signal`. */
  abstract recall(request: RecallRequest, signal?: AbortSignal): Promise<RecallResult>;
  abstract healthy(): Promise<boolean>;
}
