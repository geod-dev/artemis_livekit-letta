import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@artemis/core';
import { ProviderRegistry, parseModelHandle } from './router.ts';
import { LlmProvider, type ModelInfo } from './provider.ts';
import type { LlmRequest, LlmStreamEvent } from './types.ts';

class StubProvider extends LlmProvider {
  constructor(readonly id: string) {
    super();
  }

  stream(_request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    throw new Error('not used');
  }

  modelInfo(model: string): ModelInfo {
    return { model, contextWindow: 1, maxOutputTokens: 1, supportsThinking: false, supportsImages: false };
  }
}

test('parseModelHandle splits at the first slash', () => {
  assert.deepEqual(parseModelHandle('anthropic/claude-haiku-5-5'), {
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
  });
  assert.deepEqual(parseModelHandle('openai-compatible/zai-org/GLM-5.3-Flash'), {
    provider: 'openai-compatible',
    model: 'zai-org/GLM-5.3-Flash',
  });
});

test('parseModelHandle rejects handles without a provider or a model', () => {
  for (const handle of ['claude-haiku-5-5', '/claude', 'anthropic/', '']) {
    assert.throws(() => parseModelHandle(handle), (error: unknown) => error instanceof AppError && error.code === 'invalid_model_handle');
  }
});

test('ProviderRegistry resolves a handle to its provider and model', () => {
  const anthropic = new StubProvider('anthropic');
  const registry = new ProviderRegistry([anthropic]);
  const resolved = registry.resolve('anthropic/claude-haiku-5-5');
  assert.equal(resolved.provider, anthropic);
  assert.equal(resolved.model, 'claude-haiku-5-5');
});

test('ProviderRegistry rejects an unknown provider prefix', () => {
  const registry = new ProviderRegistry([new StubProvider('anthropic')]);
  assert.throws(() => registry.resolve('openai/gpt-x'), (error: unknown) => error instanceof AppError && error.code === 'unknown_provider');
});

test('ProviderRegistry rejects duplicate provider ids', () => {
  assert.throws(() => new ProviderRegistry([new StubProvider('anthropic'), new StubProvider('anthropic')]), /Duplicate LLM provider id/);
});
