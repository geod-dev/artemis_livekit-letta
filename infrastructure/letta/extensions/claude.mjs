/** Haiku 5.5 descriptor for the pinned Letta release's local model catalog. */
export const haikuModel = {
  id: 'claude-haiku-5-5',
  name: 'Claude Haiku 5.5',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costKnown: false,
  compat: { forceAdaptiveThinking: true, supportsTemperature: false },
  thinkingLevelMap: { minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
};

export default function registerClaude(letta) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  if (process.env.LETTA_CODE_VERSION !== '0.34.4') {
    throw new Error('Claude adapter requires Letta Code 0.34.4; revalidate before upgrading.');
  }
  return letta.providers.register('anthropic', {
    name: 'Anthropic',
    api: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKey: process.env.ANTHROPIC_API_KEY,
    models: [haikuModel],
  });
}
