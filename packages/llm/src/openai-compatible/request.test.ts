import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmRequest } from '../types.ts';
import { buildChatRequest } from './request.ts';

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'zai-org/GLM-5.3-Flash',
    system: 'system prompt',
    tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }],
    messages: [],
    maxTokens: 2048,
    thinking: 'adaptive',
    ...overrides,
  };
}

test('request params: system role, max_tokens, streamed usage, reasoning_effort, no store', () => {
  const params = buildChatRequest(request({ effort: 'high', parallelToolCalls: false }));
  assert.equal(params.model, 'zai-org/GLM-5.3-Flash');
  assert.equal(params.max_tokens, 2048);
  assert.equal(params.stream, true);
  assert.deepEqual(params.stream_options, { include_usage: true });
  assert.equal(params.reasoning_effort, 'high');
  assert.equal(params.parallel_tool_calls, false);
  assert.equal('store' in params, false);
  assert.deepEqual(params.messages[0], { role: 'system', content: 'system prompt' });
  assert.deepEqual(params.tools, [
    { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } } },
  ]);
});

test('assistant tool calls become tool_calls with JSON arguments; reasoning is not replayed', () => {
  const params = buildChatRequest(
    request({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'internal' },
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
          ],
        },
      ],
    })
  );
  assert.deepEqual(params.messages[1], {
    role: 'assistant',
    content: 'Checking.',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
  });
});

test('tool results become tool messages before the trailing user content; errors are prefixed', () => {
  const params = buildChatRequest(
    request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: 'boom' }], isError: true },
            { type: 'tool_result', toolUseId: 'call_2', content: [{ type: 'text', text: 'ok' }], isError: false },
            { type: 'text', text: 'what now?' },
          ],
        },
      ],
    })
  );
  assert.deepEqual(params.messages.slice(1), [
    { role: 'tool', tool_call_id: 'call_1', content: 'Error: boom' },
    { role: 'tool', tool_call_id: 'call_2', content: 'ok' },
    { role: 'user', content: 'what now?' },
  ]);
});

test('images become data-URL image parts, including images produced by tool results', () => {
  const params = buildChatRequest(
    request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', mediaType: 'image/png', data: 'AAAA' },
            {
              type: 'tool_result',
              toolUseId: 'call_3',
              content: [{ type: 'image', mediaType: 'image/jpeg', data: 'BBBB' }],
              isError: false,
            },
          ],
        },
      ],
    })
  );
  assert.deepEqual(params.messages.slice(1), [
    { role: 'tool', tool_call_id: 'call_3', content: '(image output follows)' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
      ],
    },
  ]);
});

test('provider options are merged last', () => {
  const params = buildChatRequest(request({ providerOptions: { top_k: 5 } }));
  assert.equal((params as unknown as { top_k: number }).top_k, 5);
});
