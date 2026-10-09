/**
 * Telnyx model capabilities that Letta's generic OpenAI-compatible discovery
 * cannot see. Tiers map Letta/SDK reasoning levels to Telnyx `reasoning_effort`
 * values; `null` marks an unsupported tier, and omitting `off` sends no effort.
 */
const REASONING_MODELS = [
  {
    // GLM 5.3: Letta/SDK call the highest tier xhigh; Telnyx/GLM call it max.
    pattern: /^zai-org\/GLM-5\.3(?:-Flash)?$/i,
    thinkingLevelMap: {
      off: null, minimal: null, low: 'low', medium: null,
      high: 'high', xhigh: 'max', max: null,
    },
  },
  {
    // DeepSeek V4 Flash: thinking is off unless an effort is sent; DeepSeek's
    // thinking tiers are high and max.
    pattern: /^deepseek-ai\/DeepSeek-V4-Flash(?:-\d+)?$/i,
    thinkingLevelMap: {
      minimal: null, low: null, medium: null,
      high: 'high', xhigh: 'max', max: null,
    },
  },
];

/** Teach Letta's local backend the reasoning capabilities of Telnyx models. */
export function telnyxModel(id) {
  const reasoning = REASONING_MODELS.find(({ pattern }) => pattern.test(id));
  return {
    id,
    name: id,
    reasoning: Boolean(reasoning),
    input: /GLM-5\.3-Flash$/i.test(id) ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: Boolean(reasoning),
      supportsStore: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
    },
    ...(reasoning ? { thinkingLevelMap: reasoning.thinkingLevelMap } : {}),
  };
}

export default function registerTelnyx(letta) {
  const upstream = process.env.OPENAI_COMPATIBLE_BASE_URL;
  if (!upstream || new URL(upstream).hostname !== 'api.telnyx.com') return;
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
      return data.map(({ id }) => telnyxModel(id));
    },
  });
}
