import type { ModelInfo } from '../provider.ts';

/**
 * Telnyx-hosted models whose capabilities are known. Telnyx does not report
 * context windows, so unlisted fields fall back to `DEFAULTS` (not verified).
 */
const KNOWN: Record<string, Partial<ModelInfo>> = {
  'zai-org/GLM-5.3-Flash': { supportsThinking: true, supportsImages: true },
};

const DEFAULTS: Omit<ModelInfo, 'model'> = {
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  supportsThinking: false,
  supportsImages: false,
};

export function openAiCompatibleModelInfo(
  model: string,
  overrides: Record<string, Partial<ModelInfo>> = {}
): ModelInfo {
  return { ...DEFAULTS, ...KNOWN[model], ...overrides[model], model };
}
