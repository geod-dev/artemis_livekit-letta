import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmRequest } from '../types.ts';
import { buildAnthropicCall } from './request.ts';

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'claude-haiku-5-5',
    system: 'You are the assistant.',
    tools: [
      { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'bash', description: 'Run a command', inputSchema: { type: 'object', properties: {} } },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 4096,
    thinking: 'adaptive',
    ...overrides,
  };
}

test('adaptive thinking shows summaries only when reasoning is requested; never sends sampling params', () => {
  const omitted = buildAnthropicCall(request(), '5m').params as unknown as Record<string, unknown>;
  assert.deepEqual(omitted.thinking, { type: 'adaptive', display: 'omitted' });
  assert.equal(omitted.max_tokens, 4096);
  for (const key of ['temperature', 'top_p', 'top_k']) assert.equal(key in omitted, false);

  const summarized = buildAnthropicCall(request({ showReasoning: true }), '5m').params as unknown as Record<string, unknown>;
  assert.deepEqual(summarized.thinking, { type: 'adaptive', display: 'summarized' });

  const disabled = buildAnthropicCall(request({ thinking: 'disabled' }), '5m').params as unknown as Record<string, unknown>;
  assert.deepEqual(disabled.thinking, { type: 'disabled' });
});

test('effort maps to output_config and every tool is eager-streamed', () => {
  const plan = buildAnthropicCall(request({ effort: 'low' }), '5m');
  assert.deepEqual(plan.params.output_config, { effort: 'low' });
  assert.ok(plan.params.tools?.every(tool => (tool as { eager_input_streaming?: boolean }).eager_input_streaming === true));
});

test('parallel tool calls are on by default and can be disabled', () => {
  assert.equal(buildAnthropicCall(request(), '5m').params.tool_choice, undefined);
  const serial = buildAnthropicCall(request({ parallelToolCalls: false }), '5m');
  assert.deepEqual(serial.params.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
});

test('cache breakpoints sit on the last tool, the system block and the last cacheable block (3 of 4)', () => {
  const plan = buildAnthropicCall(
    request({
      cache: true,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'hm', signature: 'sig' },
            { type: 'text', text: 'answer' },
            { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'a.txt' }], isError: false }],
        },
      ],
    }),
    '1h'
  );
  const params = plan.params as unknown as {
    tools: Array<{ cache_control?: unknown }>;
    system: Array<{ type: string; text: string; cache_control?: unknown }>;
    messages: Array<{ content: Array<{ cache_control?: unknown }> }>;
  };

  assert.deepEqual(params.tools[0]?.cache_control, undefined);
  assert.deepEqual(params.tools[1]?.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(params.system, [
    { type: 'text', text: 'You are the assistant.', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]);
  assert.deepEqual(params.messages.at(-1)?.content[0]?.cache_control, { type: 'ephemeral', ttl: '1h' });

  const breakpoints = JSON.stringify(plan.params).match(/"cache_control"/g) ?? [];
  assert.equal(breakpoints.length, 3);
});

test('without cache there are no breakpoints and the system prompt stays a plain string', () => {
  const plan = buildAnthropicCall(request(), '5m');
  assert.equal(plan.params.system, 'You are the assistant.');
  assert.equal(JSON.stringify(plan.params).includes('cache_control'), false);
});

test('reasoning replays with its signature, redacted reasoning with its data; unsigned reasoning is dropped', () => {
  const plan = buildAnthropicCall(
    request({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'a', signature: 'sig-a' },
            { type: 'reasoning', text: '', redacted: 'enc-b' },
            { type: 'reasoning', text: 'unsigned' },
            { type: 'text', text: 'done' },
          ],
        },
      ],
    }),
    '5m'
  );
  assert.deepEqual(plan.params.messages[0]?.content, [
    { type: 'thinking', thinking: 'a', signature: 'sig-a' },
    { type: 'redacted_thinking', data: 'enc-b' },
    { type: 'text', text: 'done' },
  ]);
});

test('compaction provider blocks replay verbatim only for Anthropic and switch on the beta', () => {
  const compaction = { type: 'compaction', content: 'summary', encrypted_content: 'enc' };
  const plan = buildAnthropicCall(
    request({
      compaction: true,
      messages: [
        { role: 'assistant', content: [{ type: 'provider', provider: 'anthropic', block: compaction }] },
        { role: 'assistant', content: [{ type: 'provider', provider: 'other', block: { type: 'x' } }] },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
    }),
    '5m'
  );
  assert.equal(plan.beta, true);
  assert.deepEqual(plan.params.betas, ['compact-2026-01-12']);
  assert.deepEqual(plan.params.context_management, { edits: [{ type: 'compact_20260112' }] });
  assert.deepEqual(plan.params.messages[0]?.content, [compaction]);
  assert.deepEqual(plan.params.messages[1]?.content, []);
});

test('tool results carry error flags and image parts; images in user turns are base64 sources', () => {
  const plan = buildAnthropicCall(
    request({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 't9',
              content: [
                { type: 'text', text: 'failed' },
                { type: 'image', mediaType: 'image/png', data: 'AAAA' },
              ],
              isError: true,
            },
            { type: 'image', mediaType: 'image/jpeg', data: 'BBBB' },
          ],
        },
      ],
    }),
    '5m'
  );
  assert.deepEqual(plan.params.messages[0]?.content, [
    {
      type: 'tool_result',
      tool_use_id: 't9',
      content: [
        { type: 'text', text: 'failed' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
      is_error: true,
    },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
  ]);
});

test('provider options are merged last as the escape hatch', () => {
  const plan = buildAnthropicCall(request({ providerOptions: { metadata: { user_id: 'u1' } } }), '5m');
  assert.deepEqual(plan.params.metadata, { user_id: 'u1' });
});
