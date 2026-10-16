import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { patchBundle, withAssistantClaudeSettings } from './model-requests.mjs';
import { haikuModel } from '../extensions/claude.mjs';

const original = readFileSync(process.env.LETTA_BUNDLE || new URL('../../../backend/node_modules/@letta-ai/letta-code/letta.js', import.meta.url), 'utf8');
const patched = patchBundle(original);
const backendRequire = createRequire(new URL('../../../backend/package.json', import.meta.url));
const sdkRequire = createRequire(backendRequire.resolve('@letta-ai/letta-agent-sdk'));
const { streamSimple } = await import(new URL('../../@earendil-works/pi-ai/dist/api/anthropic-messages.js',
  pathToFileURL(sdkRequire.resolve('@letta-ai/letta-code'))).href);

function extract(name) {
  const start = patched.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return patched.slice(start, patched.indexOf('\n}', start) + 2);
}

test('model patch applies once and keeps the published bundle valid', () => {
  assert.throws(() => patchBundle(patched), /anchor/);
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: patched, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(patched.includes('options.onPayload = withAssistantClaudeSettings(options.onPayload, input.agent.model_settings)'));
});

test('native and forked workers select Telnyx instead of inheriting the parent', async () => {
  const scope = { process: { env: {} } };
  const resolve = runInNewContext(extract('resolveSubagentModel') + '\nresolveSubagentModel', scope);
  assert.equal(await resolve({ userModel: 'inherit', parentModelHandle: 'anthropic/claude-haiku-5-5' }), 'openai-compatible/zai-org/GLM-5.3-Flash');
  const fork = runInNewContext(extract('resolveForkModelOverride') + '\nresolveForkModelOverride', scope);
  const selection = await fork({});
  assert.equal(selection.modelHandle, 'openai-compatible/zai-org/GLM-5.3-Flash');
  assert.equal(selection.updateArgs.reasoning_effort, 'high');
  const reasoning = runInNewContext(extract('reasoningForSettings') + '\nreasoningForSettings', {});
  assert.equal(reasoning({ thinking: { type: 'disabled' }, effort: 'low' }, selection.modelHandle), 'high');
});

test('reused workers receive the configured model on the child command line', () => {
  const build = runInNewContext(extract('buildSubagentArgs') + '\nbuildSubagentArgs', {
    process: { env: {} }, platform8: () => 'win32',
    cliPermissions: { getAllowedTools: () => [], getDisallowedTools: () => [] },
    sessionPermissions: { getRules: () => ({ allow: [] }) },
    NO_BASE_TOOL_SUBAGENT_TYPES: new Set(),
  });
  const args = build('general-purpose', { allowedTools: 'all', skills: [] }, null, 'Work', 'old-agent', 'old-conversation', undefined,
    { backendMode: 'local', promptTransport: 'stdin' });
  assert.equal(args[args.indexOf('--model') + 1], 'openai-compatible/zai-org/GLM-5.3-Flash');
  assert.equal(args.filter(arg => arg === '--model').length, 1);
  assert.ok(args.includes('old-conversation'));
  assert.ok(!patched.includes('const model = isDeployingExisting ? null : await resolveSubagentModel({'));
});

test('real Claude adapter sends text efforts and medium voice with thinking disabled', async () => {
  const requests = [];
  const model = { ...haikuModel, api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://api.anthropic.com' };
  const fetch = async (url, init) => {
    assert.equal(new URL(url).hostname, 'api.anthropic.com');
    requests.push(JSON.parse(init.body));
    const events = [
      { type: 'message_start', message: { id: 'test', type: 'message', role: 'assistant', model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  for (const settings of [
    ...['low', 'medium', 'high'].map(effort => ({ effort, thinking: { type: 'enabled' } })),
    { effort: 'medium', thinking: { type: 'disabled' } },
    { effort: 'high', thinking: { type: 'enabled' } },
  ]) {
    const result = await streamSimple(model, { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] }, {
      apiKey: 'test-key', reasoning: settings.thinking.type === 'disabled' ? undefined : settings.effort,
      fetch, onPayload: withAssistantClaudeSettings(undefined, settings), signal: AbortSignal.timeout(10000),
    }).result();
    assert.notEqual(result.stopReason, 'error', result.errorMessage);
  }
  assert.deepEqual(requests.map(body => body.output_config.effort), ['low', 'medium', 'high', 'medium', 'high']);
  assert.deepEqual(requests.map(body => body.thinking.type), ['adaptive', 'adaptive', 'adaptive', 'disabled', 'adaptive']);
  for (const request of requests) {
    assert.equal(request.model, 'claude-haiku-5-5');
    for (const key of ['temperature', 'top_p', 'top_k']) assert.equal(key in request, false);
  }
});

test('Claude settings preserve existing payload hooks and omit sampling controls', async () => {
  const hook = withAssistantClaudeSettings(payload => ({ ...payload, custom: true, temperature: 0.4, top_p: 0.8, top_k: 20 }), { effort: 'medium', thinking: { type: 'disabled' } });
  const result = await hook({}, haikuModel);
  assert.equal(result.custom, true);
  assert.deepEqual(result.thinking, { type: 'disabled' });
  assert.deepEqual(result.output_config, { effort: 'medium' });
  assert.equal('temperature' in result, false);
  assert.equal('top_p' in result, false);
  assert.equal('top_k' in result, false);
});
