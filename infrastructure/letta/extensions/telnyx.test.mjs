import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { assertLettaModelContract, telnyxModel } from './telnyx.mjs';

// Use the same streaming adapter that the pinned Letta backend uses.
const backendRequire = createRequire(new URL('../../../backend/package.json', import.meta.url));
const backendPackage = JSON.parse(await (await import('node:fs/promises')).readFile(
  new URL('../../../backend/package.json', import.meta.url), 'utf8',
));
assert.equal(backendPackage.dependencies['@letta-ai/letta-code'], '0.34.4',
  'revalidate this adapter when the pinned Letta version changes');
const sdkRequire = createRequire(backendRequire.resolve('@letta-ai/letta-agent-sdk'));
const { getSupportedThinkingLevels } = await import(
  new URL('../../@earendil-works/pi-ai/dist/index.js',
    pathToFileURL(sdkRequire.resolve('@letta-ai/letta-code'))).href
);
const { streamSimple } = await import(new URL(
  '../../@earendil-works/pi-ai/dist/api/openai-completions.js',
  pathToFileURL(sdkRequire.resolve('@letta-ai/letta-code')),
).href);

/** Stream one request per tier through a stub server; resolve with the request bodies. */
async function requestsFor(id, tiers) {
  const requests = [];
  const fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const chunk = { id: 'test', object: 'chat.completion.chunk', created: 0,
      model: id, choices: [{ index: 0,
        delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  const model = { ...telnyxModel(id),
    api: 'openai-completions', provider: 'openai-compatible',
    baseUrl: 'https://provider.invalid/v1' };
  for (const reasoning of tiers) {
    const result = await streamSimple(model, {
      messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
    }, { apiKey: 'test-key', reasoning, fetch, signal: AbortSignal.timeout(10000) }).result();
    assert.notEqual(result.stopReason, 'error', result.errorMessage);
  }
  assert.ok(requests.every(r => r.model === id));
  return { model, requests };
}

test('all three GLM tiers reach the HTTP request as low, high, max', async () => {
  const { model, requests } = await requestsFor('zai-org/GLM-5.3-Flash', ['low', 'high', 'xhigh']);
  assert.deepEqual(getSupportedThinkingLevels(model), ['low', 'high', 'xhigh']);
  assert.deepEqual(requests.map(r => r.reasoning_effort), ['low', 'high', 'max']);
});

test('DeepSeek V4 Flash sends no effort when off, and high or max when thinking', async () => {
  const id = 'deepseek-ai/DeepSeek-V4-Flash-0731';
  const { model, requests } = await requestsFor(id, [undefined, 'high', 'xhigh']);
  assert.deepEqual(getSupportedThinkingLevels(model), ['off', 'high', 'xhigh']);
  assert.deepEqual(requests.map(r => r.reasoning_effort), [undefined, 'high', 'max']);
  assert.equal(model.compat.supportsDeveloperRole, false);
});

test('other Telnyx models retain the generic provider capabilities', () => {
  const model = telnyxModel('some-other-model');
  assert.equal(model.reasoning, false);
  assert.equal(model.compat.supportsReasoningEffort, false);
  assert.deepEqual(model.input, ['text']);
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(model.costKnown, false);
  assert.equal('contextWindow' in model, false);
  assert.equal('maxTokens' in model, false);
});

test('provider metadata is preserved when the upstream model list supplies it', () => {
  const model = telnyxModel('some-other-model', {
    input: ['text', 'image'], context_window: 65536, max_output_tokens: 4096,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  });
  assert.deepEqual(model.input, ['text', 'image']);
  assert.equal(model.contextWindow, 65536);
  assert.equal(model.maxTokens, 4096);
  assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.equal(model.costKnown, true);
});

test('adapter contract rejects an unvalidated Letta version', () => {
  assert.doesNotThrow(() => assertLettaModelContract('0.34.4'));
  assert.throws(() => assertLettaModelContract('0.35.0'), /requires Letta Code 0\.34\.4/);
  assert.throws(() => assertLettaModelContract(undefined), /found unknown/);
});
