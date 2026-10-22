import type { ModelInfo } from '../provider.ts';

/** Known Claude models. Limits are the published values for each model. */
const KNOWN: Record<string, Omit<ModelInfo, 'model'>> = {
  'claude-haiku-5-5': {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
  },
};

/**
 * Unlisted Claude models get conservative limits (not verified per model), so new
 * model ids work before this table is updated.
 */
const FALLBACK: Omit<ModelInfo, 'model'> = {
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  supportsThinking: true,
  supportsImages: true,
};

export function anthropicModelInfo(model: string): ModelInfo {
  return { model, ...(KNOWN[model] ?? FALLBACK) };
}
