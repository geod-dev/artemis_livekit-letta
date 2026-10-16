/**
 * Telnyx model capabilities that Letta's generic OpenAI-compatible discovery
 * cannot see. Workers expose only provider effort high; null marks unsupported levels.
 */
const REASONING_MODELS = [
  {
    pattern: /^zai-org\/GLM-5\.3-Flash$/i,
    thinkingLevelMap: {
      off: null, minimal: null, low: null, medium: null,
      high: 'high', xhigh: null, max: null,
    },
  },
];

const PINNED_LETTA_CODE_VERSION = '0.34.4';

/** Keep the private Letta model descriptor contract explicit and fail closed. */
export function assertLettaModelContract(version) {
  if (version !== PINNED_LETTA_CODE_VERSION) {
    throw new Error(`Telnyx model adapter requires Letta Code ${PINNED_LETTA_CODE_VERSION}; found ${version || 'unknown'}`);
  }
}

/** Teach Letta's local backend the reasoning capabilities of Telnyx models. */
export function telnyxModel(id, metadata = {}) {
  const reasoning = REASONING_MODELS.find(({ pattern }) => pattern.test(id));
  const supportsVision = /^zai-org\/GLM-5\.3(?:-Flash)?$/i.test(id);
  const input = Array.isArray(metadata.input) ? [...metadata.input] : ['text'];
  if (supportsVision && !input.includes('image')) input.push('image');
  const model = {
    id,
    name: id,
    reasoning: Boolean(reasoning),
    // Telnyx does not consistently advertise modalities. GLM 5.3 supports
    // vision, so expose image input even when the model list omits it.
    input,
    // Pi's response accounting requires this object even when discovery has no
    // pricing. These neutral accounting values are not advertised prices.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costKnown: false,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: Boolean(reasoning),
      supportsStore: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
    },
    ...(reasoning ? { thinkingLevelMap: reasoning.thinkingLevelMap } : {}),
  };
  // The upstream model list does not consistently report cost or limits.
  // Preserve stated prices separately from the required accounting fallback;
  // leave context/output limits unknown when the provider has not stated them.
  const contextWindow = metadata.contextWindow ?? metadata.context_window ?? metadata.context_length;
  const maxTokens = metadata.maxTokens ?? metadata.max_tokens ?? metadata.max_output_tokens;
  if (Number.isFinite(contextWindow) && contextWindow > 0) model.contextWindow = contextWindow;
  if (Number.isFinite(maxTokens) && maxTokens > 0) model.maxTokens = maxTokens;
  if (metadata.cost && ['input', 'output', 'cacheRead', 'cacheWrite']
      .every(key => Number.isFinite(metadata.cost[key]) && metadata.cost[key] >= 0)) {
    model.cost = metadata.cost;
    model.costKnown = true;
  }
  return model;
}

export default function registerTelnyx(letta) {
  const upstream = process.env.OPENAI_COMPATIBLE_BASE_URL;
  if (!upstream || new URL(upstream).hostname !== 'api.telnyx.com') return;
  assertLettaModelContract(process.env.LETTA_CODE_VERSION);
  const baseUrl = process.env.OPENAI_COMPATIBLE_PROXY_URL || upstream;
  return letta.providers.register('openai-compatible', {
    name: 'Telnyx',
    api: 'openai-completions',
    baseUrl,
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
    async listModels() {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_COMPATIBLE_API_KEY}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Telnyx model discovery failed: HTTP ${response.status}`);
      const { data } = await response.json();
      return data.map(({ id, ...metadata }) => telnyxModel(id, metadata));
    },
  });
}
