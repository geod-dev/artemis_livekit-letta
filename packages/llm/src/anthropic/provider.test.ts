import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmError } from '../provider.ts';
import type { LlmRequest, LlmStreamEvent } from '../types.ts';
import { jsonResponse, openStream, recordingFetch, sseResponse, type SseEvent } from '../testing/sse.ts';
import { AnthropicLlmProvider } from './index.ts';

/** Event sequence as the Messages API streams it (hand-written from the SDK's event types). */
const TOOL_TURN: SseEvent[] = [
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 1 },
      },
    },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me look.' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-123' } },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } },
  },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' it.' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  },
  {
    event: 'content_block_delta',
    data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 42 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

const REQUEST: LlmRequest = {
  model: 'claude-haiku-5-5',
  system: 'system',
  tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'read a.txt' }] }],
  maxTokens: 1024,
  thinking: 'adaptive',
  showReasoning: true,
  effort: 'medium',
  cache: true,
};

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function providerWith(fetch: typeof globalThis.fetch, extra: { cacheTtl?: '5m' | '1h' } = {}): AnthropicLlmProvider {
  return new AnthropicLlmProvider({ apiKey: 'test-key', baseUrl: 'https://anthropic.test', maxRetries: 0, fetch, ...extra });
}

test('streams a tool turn into canonical events and a final response with signed reasoning', async () => {
  const { fetch, requests } = recordingFetch(() => sseResponse(TOOL_TURN));
  const events = await collect(providerWith(fetch).stream(REQUEST));

  assert.deepEqual(
    events.map(e => e.type),
    [
      'message_start',
      'block_start',
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
  const toolStart = events.find(e => e.type === 'block_start' && e.block === 'tool_use');
  assert.deepEqual(toolStart, { type: 'block_start', index: 2, block: 'tool_use', toolUseId: 'toolu_1', toolName: 'read_file' });

  const end = events.at(-1);
  assert.equal(end?.type, 'message_end');
  if (end?.type !== 'message_end') return;
  const response = end.message;
  assert.equal(response.providerMessageId, 'msg_01');
  assert.equal(response.stopReason, 'tool_use');
  assert.deepEqual(response.content, [
    { type: 'reasoning', text: 'Let me look.', signature: 'sig-123' },
    { type: 'text', text: 'Reading it.' },
    { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } },
  ]);
  assert.deepEqual(response.usage, {
    inputTokens: 125,
    outputTokens: 42,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
  });
  assert.ok(response.timings.firstTokenMs !== undefined);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://anthropic.test/v1/messages');
  assert.equal(requests[0]?.headers.get('authorization'), 'Bearer test-key');
});

test('request body: adaptive thinking summaries, effort, eager tools, cache breakpoints, no sampling params', async () => {
  const { fetch, requests } = recordingFetch(() => sseResponse(TOOL_TURN));
  await collect(providerWith(fetch, { cacheTtl: '1h' }).stream(REQUEST));
  const body = requests[0]?.body ?? {};

  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 1024);
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body.output_config, { effort: 'medium' });
  assert.equal('temperature' in body, false);
  assert.deepEqual(body.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(body.tools[0].eager_input_streaming, true);
  assert.equal(body.system[0].cache_control?.ttl, '1h');
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('compaction uses the beta endpoint and keeps the compaction block for replay', async () => {
  const compactionTurn: SseEvent[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { id: 'msg_c', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
      },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: null, encrypted_content: null } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: 'Earlier: ', encrypted_content: null } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: 'summary.', encrypted_content: 'enc-9' } },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } },
    },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  const { fetch, requests } = recordingFetch(() => sseResponse(compactionTurn));
  const events = await collect(providerWith(fetch).stream({ ...REQUEST, compaction: true, cache: false }));

  assert.equal(requests[0]?.headers.get('anthropic-beta'), 'compact-2026-01-12');
  assert.deepEqual(requests[0]?.body.context_management, { edits: [{ type: 'compact_20260112' }] });
  const end = events.at(-1);
  assert.equal(end?.type, 'message_end');
  if (end?.type !== 'message_end') return;
  assert.deepEqual(end.message.content[0], {
    type: 'provider',
    provider: 'anthropic',
    block: { type: 'compaction', content: 'Earlier: summary.', encrypted_content: 'enc-9' },
  });
  assert.deepEqual(end.message.content[1], { type: 'text', text: 'ok' });
});

test('an aborted stream ends with message_end aborted and the partial content', async () => {
  const controller = new AbortController();
  const prefix = TOOL_TURN.slice(0, 7).map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const { fetch } = recordingFetch((_request, init) => openStream(prefix, init));
  const events: LlmStreamEvent[] = [];
  for await (const event of providerWith(fetch).stream(REQUEST, controller.signal)) {
    events.push(event);
    if (event.type === 'text_delta' || event.type === 'reasoning_delta') controller.abort();
  }

  const end = events.at(-1);
  assert.equal(end?.type, 'message_end');
  if (end?.type !== 'message_end') return;
  assert.equal(end.message.stopReason, 'aborted');
  // Events already read before the abort are kept; the first block is the thinking text.
  assert.equal(end.message.content[0]?.type, 'reasoning');
  assert.equal((end.message.content[0] as { text: string }).text, 'Let me look.');
});

test('failures before any output throw LlmError with the mapped code', async () => {
  const cases: Array<[number, unknown, string, boolean]> = [
    [429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'rate_limited', true],
    [529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 'overloaded', true],
    [401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 'auth', false],
    [
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } },
      'context_overflow',
      false,
    ],
  ];
  for (const [status, body, code, retryable] of cases) {
    const { fetch } = recordingFetch(() => jsonResponse(status, body));
    await assert.rejects(collect(providerWith(fetch).stream(REQUEST)), (error: unknown) => {
      assert.ok(error instanceof LlmError, `expected LlmError for ${status}`);
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      return true;
    });
  }
});

test('a failure after output started ends the step with stopReason error', async () => {
  const partial: SseEvent[] = [
    TOOL_TURN[0] as SseEvent,
    TOOL_TURN[5] as SseEvent,
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Par' } } },
    { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
  ];
  const { fetch } = recordingFetch(() => sseResponse(partial));
  const events = await collect(providerWith(fetch).stream(REQUEST));
  const end = events.at(-1);
  assert.equal(end?.type, 'message_end');
  if (end?.type !== 'message_end') return;
  assert.equal(end.message.stopReason, 'error');
  assert.ok(end.message.error);
  assert.deepEqual(end.message.content, [{ type: 'text', text: 'Par' }]);
});

test('modelInfo: Haiku 5.5 limits; unlisted Claude models get the conservative fallback', () => {
  const provider = providerWith(recordingFetch(() => sseResponse([])).fetch);
  assert.deepEqual(provider.modelInfo('claude-haiku-5-5'), {
    model: 'claude-haiku-5-5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsThinking: true,
    supportsImages: true,
  });
  assert.equal(provider.modelInfo('claude-future-9').contextWindow, 200_000);
});
