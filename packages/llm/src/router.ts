import { AppError } from '@artemis/core';
import type { LlmProvider } from './provider.ts';
import type { Effort, ThinkingMode } from './types.ts';

/**
 * `anthropic/claude-haiku-5-5` -> `{provider:'anthropic', model:'claude-haiku-5-5'}`;
 * `openai-compatible/zai-org/GLM-5.3-Flash` -> `{provider:'openai-compatible', model:'zai-org/GLM-5.3-Flash'}`.
 * Splits at the first `/`; throws on a handle without one.
 */
export function parseModelHandle(handle: string): { provider: string; model: string } {
  const slash = handle.indexOf('/');
  const provider = slash > 0 ? handle.slice(0, slash) : '';
  const model = slash > 0 ? handle.slice(slash + 1) : '';
  if (!provider || !model) {
    throw new AppError('invalid_model_handle', `Model handle must look like "provider/model": "${handle}"`, 400);
  }
  return { provider, model };
}

/** Resolved settings for one kind of model call (see agent-server `models/routing.ts`). */
export interface ModelRoute {
  provider: LlmProvider;
  model: string;
  thinking: ThinkingMode;
  effort?: Effort;
  maxTokens: number;
  showReasoning: boolean;
  cache: boolean;
  compaction: boolean;
}

/** Providers by id; resolves `provider/model` handles. */
export class ProviderRegistry {
  private readonly byId: Map<string, LlmProvider>;

  constructor(readonly providers: readonly LlmProvider[]) {
    this.byId = new Map();
    for (const provider of providers) {
      if (this.byId.has(provider.id)) {
        throw new Error(`Duplicate LLM provider id: ${provider.id}`);
      }
      this.byId.set(provider.id, provider);
    }
  }

  /** Throws for an unknown provider prefix. */
  resolve(handle: string): { provider: LlmProvider; model: string } {
    const parsed = parseModelHandle(handle);
    const provider = this.byId.get(parsed.provider);
    if (!provider) {
      throw new AppError('unknown_provider', `No LLM provider registered as "${parsed.provider}"`, 400);
    }
    return { provider, model: parsed.model };
  }
}
