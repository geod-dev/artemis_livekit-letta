import { notImplemented } from '@artemis/core';
import type { LlmProvider } from './provider.ts';
import type { Effort, ThinkingMode } from './types.ts';

/**
 * `anthropic/claude-haiku-5-5` -> `{provider:'anthropic', model:'claude-haiku-5-5'}`;
 * `openai-compatible/zai-org/GLM-5.3-Flash` -> `{provider:'openai-compatible', model:'zai-org/GLM-5.3-Flash'}`.
 * Splits at the first `/`; throws on a handle without one.
 */
export function parseModelHandle(_handle: string): { provider: string; model: string } {
  return notImplemented('parseModelHandle');
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
  constructor(readonly providers: readonly LlmProvider[]) {}

  /** Throws for an unknown provider prefix. */
  resolve(_handle: string): { provider: LlmProvider; model: string } {
    return notImplemented('ProviderRegistry.resolve');
  }
}
