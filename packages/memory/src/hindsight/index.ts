import {
  HindsightClient,
  type MemoryItemInput,
  type RecallResult as HindsightRecallResult,
} from '@vectorize-io/hindsight-client';
import { formatTranscript } from '../render.ts';
import {
  MemoryStore,
  type MemoryFact,
  type RecallRequest,
  type RecallResult,
  type RetainRequest,
} from '../store.ts';

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

const FACT_TYPES = ['world', 'experience', 'observation'] as const satisfies readonly MemoryFact['type'][];
const HEALTH_TIMEOUT_MS = 3_000;

type FactType = (typeof FACT_TYPES)[number];

function isFactType(value: string | null | undefined): value is FactType {
  return FACT_TYPES.some((type) => type === value);
}

/** Maps one Hindsight recall result to a fact; results of unknown fact types are dropped. */
function toMemoryFact(result: HindsightRecallResult): MemoryFact[] {
  if (!isFactType(result.type)) return [];
  const fact: MemoryFact = { id: result.id, text: result.text, type: result.type };
  if (result.occurred_start) fact.occurredAt = result.occurred_start;
  if (result.mentioned_at) fact.mentionedAt = result.mentioned_at;
  return [fact];
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
  private readonly client: HindsightClient;

  constructor(readonly options: HindsightMemoryOptions) {
    super();
    this.client = new HindsightClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  }

  async ensureReady(): Promise<void> {
    await this.client.createBank(this.options.bankId, {
      retainMission: this.options.retainMission,
      reflectMission: this.options.reflectMission,
    });
  }

  async retain(request: RetainRequest, signal?: AbortSignal): Promise<{ operationId: string }> {
    const item: MemoryItemInput = {
      content: formatTranscript(request.turns),
      timestamp: request.timestamp,
      context: request.context,
      metadata: request.metadata,
      document_id: request.documentId,
      tags: request.tags,
      update_mode: 'append',
    };
    const response = await this.client.retainBatch(this.options.bankId, [item], {
      async: true,
      operationId: request.operationId,
      signal,
    });
    if (!response.success) {
      throw new Error(`Hindsight rejected retain operation ${request.operationId}`);
    }
    return { operationId: request.operationId };
  }

  async recall(request: RecallRequest, signal?: AbortSignal): Promise<RecallResult> {
    const response = await this.client.recall(this.options.bankId, request.query, {
      types: [...FACT_TYPES],
      budget: request.budget,
      maxTokens: request.maxTokens,
      queryTimestamp: request.queryTimestamp,
      preferObservations: true,
      tags: request.tags,
      signal,
    });
    return { facts: response.results.flatMap(toMemoryFact) };
  }

  async healthy(): Promise<boolean> {
    try {
      await this.client.getVersion({ signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      return true;
    } catch {
      return false;
    }
  }
}
