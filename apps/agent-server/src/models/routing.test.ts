import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type LlmRequest, LlmProvider, type LlmStreamEvent, type ModelInfo, ProviderRegistry } from '@artemis/llm';
import { loadConfig } from '../config.ts';
import { createModelRouter } from './routing.ts';

/** Provider stub: routing never streams, it only reports model limits. */
class LimitsProvider extends LlmProvider {
  constructor(readonly id: string, private readonly maxOutput: number) {
    super();
  }

  async *stream(_request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    throw new Error('routing tests do not stream');
  }

  modelInfo(model: string): ModelInfo {
    return { model, contextWindow: 1_000_000, maxOutputTokens: this.maxOutput, supportsThinking: true, supportsImages: true };
  }
}

function setup(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ DATABASE_URL: 'postgresql://x', ...env });
  const providers = new ProviderRegistry([
    new LimitsProvider('anthropic', 128_000),
    new LimitsProvider('openai-compatible', 16_000),
  ]);
  return createModelRouter(config, providers);
}

describe('createModelRouter', () => {
  it('routes text turns to adaptive thinking with the turn effort and cache and compaction on', () => {
    const router = setup();
    const route = router.route('assistant-text', { effort: 'high' });
    assert.equal(route.provider.id, 'anthropic');
    assert.equal(route.model, 'claude-haiku-5-5');
    assert.equal(route.thinking, 'adaptive');
    assert.equal(route.effort, 'high');
    assert.equal(route.showReasoning, true);
    assert.equal(route.cache, true);
    assert.equal(route.compaction, true);
    assert.equal(route.maxTokens, 32_000);
  });

  it('defaults a text turn without effort to medium', () => {
    assert.equal(setup().route('assistant-text').effort, 'medium');
  });

  it('routes voice turns with thinking disabled and medium effort, whatever the requested effort', () => {
    const route = setup().route('assistant-voice', { effort: 'max' });
    assert.equal(route.provider.id, 'anthropic');
    assert.equal(route.thinking, 'disabled');
    assert.equal(route.effort, 'medium');
    assert.equal(route.showReasoning, false);
    assert.equal(route.cache, true);
  });

  it('routes updates at low effort for text and like voice for spoken updates', () => {
    const router = setup();
    const text = router.route('update', { modality: 'text' });
    assert.equal(text.thinking, 'adaptive');
    assert.equal(text.effort, 'low');
    const voice = router.route('update', { modality: 'voice' });
    assert.equal(voice.thinking, 'disabled');
    assert.equal(voice.effort, 'medium');
  });

  it('routes workers to the task model at high effort and never inherits parent settings', () => {
    const route = setup().route('worker', { effort: 'low', modality: 'voice' });
    assert.equal(route.provider.id, 'openai-compatible');
    assert.equal(route.model, 'zai-org/GLM-5.3-Flash');
    assert.equal(route.effort, 'high');
    assert.equal(route.cache, false);
    assert.equal(route.compaction, false);
    assert.equal(route.maxTokens, 16_000);
  });

  it('routes titles to the title model with thinking disabled, low effort and 64 output tokens', () => {
    const route = setup({ ASSISTANT_TITLE_MODEL: 'anthropic/claude-small' }).route('title');
    assert.equal(route.provider.id, 'anthropic');
    assert.equal(route.model, 'claude-small');
    assert.equal(route.thinking, 'disabled');
    assert.equal(route.effort, 'low');
    assert.equal(route.maxTokens, 64);
    assert.equal(route.cache, false);
  });

  it('never sets sampling parameters', () => {
    const route = setup().route('assistant-text');
    assert.equal('temperature' in route, false);
    assert.equal('topP' in route, false);
    assert.equal('topK' in route, false);
  });

  it('fails at boot when a configured model has no registered provider', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x', ASSISTANT_TASK_MODEL: 'mistral/large' });
    const providers = new ProviderRegistry([new LimitsProvider('anthropic', 128_000)]);
    assert.throws(() => createModelRouter(config, providers), /mistral/);
  });
});
