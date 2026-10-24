import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@artemis/core';
import { ProviderRegistry, parseModelHandle } from './router.ts';
import { FakeProvider } from './testing/fake-provider.ts';

/** A provider that is only registered, never called: the routing tests do not stream. */
const StubProvider = (id: string): FakeProvider => new FakeProvider([], id);

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
    assert.throws(
      () => parseModelHandle(handle),
      (error: unknown) => error instanceof AppError && error.code === 'invalid_model_handle'
    );
  }
});

test('ProviderRegistry resolves a handle to its provider and model', () => {
  const anthropic = StubProvider('anthropic');
  const registry = new ProviderRegistry([anthropic]);
  const resolved = registry.resolve('anthropic/claude-haiku-5-5');
  assert.equal(resolved.provider, anthropic);
  assert.equal(resolved.model, 'claude-haiku-5-5');
});

test('ProviderRegistry rejects an unknown provider prefix', () => {
  const registry = new ProviderRegistry([StubProvider('anthropic')]);
  assert.throws(
    () => registry.resolve('openai/gpt-x'),
    (error: unknown) => error instanceof AppError && error.code === 'unknown_provider'
  );
});

test('ProviderRegistry rejects duplicate provider ids', () => {
  assert.throws(
    () => new ProviderRegistry([StubProvider('anthropic'), StubProvider('anthropic')]),
    /Duplicate LLM provider id/
  );
});
