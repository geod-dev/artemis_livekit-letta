import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { patchBundle } from './patch-groq-qwen.mjs';

// Test the actual published adapter rather than a copy of its role selection.
// LETTA_BUNDLE points to the original 0.34.4 npm package's letta.js.
const bundlePath = process.env.LETTA_BUNDLE;
if (!bundlePath) throw new Error('Set LETTA_BUNDLE to the original Letta 0.34.4 letta.js');
const original = readFileSync(bundlePath, 'utf8');
const patched = patchBundle(original);

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end >= 0, `Missing end of ${name}`);
  return source.slice(start, end + 2);
}

function adapter(source) {
  return runInNewContext([
    extract(source, 'detectCompat'),
    extract(source, 'getCompat'),
    extract(source, 'convertMessages'),
    '({ getCompat, convertMessages })',
  ].join('\n'), {
    resolveTranscript: (context) => context,
    transformMessages: (messages) => messages,
    resolveTranscriptTools: () => ({ anchorsAdditions: false }),
    getSystemMessageText: (message) => message.content,
    renderSystemMessageUpdate: (message) => message.content,
    sanitizeSurrogates: (text) => text,
    isTextContentBlock: (block) => block.type === 'text',
    isThinkingContentBlock: (block) => block.type === 'thinking',
    isToolCallBlock: (block) => block.type === 'toolCall',
  });
}

const before = adapter(original);
const after = adapter(patched);
const context = {
  messages: [
    { role: 'system', content: 'You are a helpful assistant. Memory: Alice.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi Alice' }] },
  ],
};
const model = {
  provider: 'groq', id: 'qwen/qwen3-32b',
  baseUrl: 'https://api.groq.com/openai/v1', reasoning: true,
};

test('Groq Qwen sends system instructions and retains conversation content', () => {
  const oldMessages = before.convertMessages(model, context, before.getCompat(model));
  assert.equal(oldMessages[0].role, 'developer');
  const newMessages = after.convertMessages(model, context, after.getCompat(model));
  assert.deepEqual(JSON.parse(JSON.stringify(newMessages)), [
    { role: 'system', content: context.messages[0].content },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi Alice' },
  ]);
});

test('switching providers or selecting Groq GPT-OSS leaves capabilities unchanged', () => {
  for (const candidate of [
    { ...model, provider: 'openai' },
    { ...model, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
    { ...model, provider: 'cerebras', id: 'gpt-oss-120b' },
    { ...model, id: 'openai/gpt-oss-120b' },
    { ...model, id: 'llama-3.3-70b-versatile', reasoning: false },
  ]) {
    assert.equal(JSON.stringify(after.getCompat(candidate)), JSON.stringify(before.getCompat(candidate)));
  }
});

test('override does not mutate model or discard other compatibility settings', () => {
  const candidate = { ...model, compat: { supportsDeveloperRole: true, maxTokensField: 'max_tokens' } };
  const snapshot = JSON.stringify(candidate);
  const compatibility = after.getCompat(candidate);
  assert.equal(compatibility.supportsDeveloperRole, false);
  assert.equal(compatibility.maxTokensField, 'max_tokens');
  assert.equal(JSON.stringify(candidate), snapshot);
});

test('patch fails closed if the bundled adapter changes or is already patched', () => {
  assert.throws(() => patchBundle('different release'), /exactly one/);
  assert.throws(() => patchBundle(patched), /exactly one/);
});
