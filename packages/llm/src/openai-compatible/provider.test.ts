import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmError } from '../provider.ts';
import type { LlmRequest, LlmStreamEvent } from '../types.ts';
import { jsonResponse, openStream, recordingFetch, sseResponse, type SseEvent } from '../testing/sse.ts';
import { OpenAiCompatibleLlmProvider } from './index.ts';

const BASE = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'zai-org/GLM-5.3-Flash' };

function chunk(delta: Record<string, unknown>, finish: string | null = null): SseEvent {
  return { data: { ...BASE, choices: [{ index: 0, delta, finish_reason: finish }] } };
}

/** Chunk sequence as Telnyx streams GLM (hand-written from the Chat Completions chunk shape). */
const TOOL_TURN: SseEvent[] = [
  chunk({ role: 'assistant', reasoning_content: 'Thinking' }),
  chunk({ reasoning_content: ' hard' }),
  chunk({ content: 'Hel' }),
  chunk({ content: 'lo' }),
  chunk({
    tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: ': "a.txt"}' } }] }),
  chunk({}, 'tool_calls'),
  {
    data: {
      ...BASE,
      choices: [],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 12,
        total_tokens: 62,
        prompt_tokens_details: { cached_tokens: 10 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    },
  },
];

const REQUEST: LlmRequest = {
  model: 'zai-org/GLM-5.3-Flash',
  system: 'system',
  tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'read a.txt' }] }],
  maxTokens: 512,
  thinking: 'adaptive',
  effort: 'high',
};

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function providerWith(fetch: typeof globalThis.fetch): OpenAiCompatibleLlmProvider {
  return new OpenAiCompatibleLlmProvider({
    baseUrl: 'https://telnyx.test/v2/ai/openai',
    apiKey: 'test-key',
    maxRetries: 0,
    fetch,
  });
}

test('streams reasoning, text and tool calls into canonical blocks with usage', async () => {
  const { fetch, requests } = recordingFetch(() => sseResponse(TOOL_TURN, { done: true }));
  const events = await collect(providerWith(fetch).stream(REQUEST));

  assert.deepEqual(
    events.map(e => e.type),
    [
      'message_start',
      'block_start',
      'reasoning_delta',
      'reasoning_delta',
      'block_end',
      'block_start',
      'text_delta',
      'text_delta',
      'block_end',
      'block_start',
      'tool_input_delta',
      'tool_input_delta',
      'block_end',
      'message_end',
    ]
  );
  assert.deepEqual(events[9], { type: 'block_start', index: 2, block: 'tool_use', toolUseId: 'call_1', toolName: 'read_file' });

  const end = events.at(-1);
  assert.equal(end?.type, 'message_end');
  if (end?.type !== 'message_end') return;
  assert.equal(end.message.providerMessageId, 'chatcmpl-1');
  assert.equal(end.message.stopReason, 'tool_use');
  assert.deepEqual(end.message.content, [
    { type: 'reasoning', text: 'Thinking hard' },
    { type: 'text', text: 'Hello' },
    { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
  ]);
  assert.deepEqual(end.message.usage, { inputTokens: 50, outputTokens: 12, cacheReadTokens: 10, reasoningTokens: 5 });

  assert.equal(requests[0]?.url, 'https://telnyx.test/v2/ai/openai/chat/completions');
  assert.equal(requests[0]?.body.reasoning_effort, 'high');
  assert.equal(requests[0]?.body.max_tokens, 512);
  assert.equal('store' in (requests[0]?.body ?? {}), false);
});

test('a finish_reason of length maps to max_tokens and content_filter to refusal', async () => {
  const cases: Array<[string, string]> = [
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
  ];
  for (const [finish, expected] of cases) {
    const { fetch } = recordingFetch(() => sseResponse([chunk({ content: 'x' }, finish)], { done: true }));
    const events = await collect(providerWith(fetch).stream(REQUEST));
    const end = events.at(-1);
    assert.equal(end?.type === 'message_end' && end.message.stopReason, expected);
  }
});

test('an aborted stream ends with message_end aborted and the partial text', async () => {
  const controller = new AbortController();
  const prefix = TOOL_TURN.slice(0, 3).map(({ data }) => `data: ${JSON.stringify(data)}\n\n`).join('');
  const { fetch } = recordingFetch((_request, init) => openStream(prefix, init));
  const events: LlmStreamEvent[] = [];
  for await (const event of providerWith(fetch).stream(REQUEST, controller.signal)) {
    events.push(event);
    if (event.type === 'reasoning_delta') controller.abort();
  }
  const end = events.at(-1);
  assert.equal(end?.type, 'message_end');
  if (end?.type !== 'message_end') return;
  assert.equal(end.message.stopReason, 'aborted');
  assert.equal(end.message.content[0]?.type, 'reasoning');
});

test('HTTP failures before output throw LlmError with the mapped code', async () => {
  const cases: Array<[number, string, boolean]> = [
    [429, 'rate_limited', true],
    [401, 'auth', false],
    [400, 'invalid_request', false],
  ];
  for (const [status, code, retryable] of cases) {
    const { fetch } = recordingFetch(() =>
      jsonResponse(status, { error: { message: `status ${status}`, type: 'x', code: null } })
    );
    await assert.rejects(collect(providerWith(fetch).stream(REQUEST)), (error: unknown) => {
      assert.ok(error instanceof LlmError, `expected LlmError for ${status}`);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      return true;
    });
  }
});

test('a stream that ends without a finish_reason ends with stopReason error', async () => {
  const { fetch } = recordingFetch(() => sseResponse([chunk({ content: 'partial' })], { done: true }));
  const events = await collect(providerWith(fetch).stream(REQUEST));
  const end = events.at(-1);
  assert.equal(end?.type, 'message_end');
  if (end?.type !== 'message_end') return;
  assert.equal(end.message.stopReason, 'error');
  assert.equal(end.message.error?.code, 'no_response');
});

test('modelInfo: known GLM capabilities, defaults and per-provider overrides', () => {
  const provider = new OpenAiCompatibleLlmProvider({
    baseUrl: 'https://telnyx.test/v2/ai/openai',
    apiKey: 'k',
    models: { 'other/model': { contextWindow: 32_000 } },
  });
  assert.equal(provider.modelInfo('zai-org/GLM-5.3-Flash').supportsImages, true);
  assert.equal(provider.modelInfo('other/model').contextWindow, 32_000);
  assert.equal(provider.modelInfo('other/model').supportsImages, false);
});
