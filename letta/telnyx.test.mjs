import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { telnyxModel } from './telnyx.mjs';

// Use the same streaming adapter that the pinned Letta backend uses.
const backendRequire = createRequire(new URL('../backend/package.json', import.meta.url));
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
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = { id: 'test', object: 'chat.completion.chunk', created: 0,
      model: id, choices: [{ index: 0,
        delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] };
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const model = { ...telnyxModel(id),
      api: 'openai-completions', provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
    for (const reasoning of tiers) {
      const result = await streamSimple(model, {
        messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }],
      }, { apiKey: 'test-key', reasoning, signal: AbortSignal.timeout(10000) }).result();
      assert.notEqual(result.stopReason, 'error', result.errorMessage);
    }
    assert.ok(requests.every(r => r.model === id));
    return { model, requests };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
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
});
