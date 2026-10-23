import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponseAccumulator, parseToolInput } from './accumulator.ts';
import { LlmError } from './provider.ts';
import { llmErrorFromHttp, llmNetworkError } from './http-errors.ts';
import type { LlmResponse, LlmStreamEvent } from './types.ts';

function finalMessage(events: LlmStreamEvent[]): LlmResponse {
  const end = events.at(-1);
  assert.equal(end?.type, 'message_end');
  return end.message;
}

test('parseToolInput returns objects and falls back to {} for empty, cut-off or non-object JSON', () => {
  assert.deepEqual(parseToolInput('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolInput(''), {});
  assert.deepEqual(parseToolInput('{"a":'), {});
  assert.deepEqual(parseToolInput('[1,2]'), {});
  assert.deepEqual(parseToolInput('"text"'), {});
});

test('opening a block closes the previous one and empty text blocks keep their slot', () => {
  const acc = new ResponseAccumulator('m', () => 0);
  acc.messageStart({ providerMessageId: 'x' });
  const empty = acc.startBlock('text');
  acc.startBlock('reasoning');
  acc.reasoning(1, 'thinking');
  acc.finish('end_turn');
  const events = acc.drain();

  assert.deepEqual(
    events.map(e => e.type),
    ['message_start', 'block_start', 'block_end', 'block_start', 'reasoning_delta', 'block_end', 'message_end']
  );
  assert.equal(empty, 0);
  assert.deepEqual(finalMessage(events).content, [
    { type: 'text', text: '' },
    { type: 'reasoning', text: 'thinking' },
  ]);
});

test('an empty leading text block keeps stream and stored block indexes aligned', () => {
  const acc = new ResponseAccumulator('m', () => 0);
  acc.messageStart({ providerMessageId: 'x' });
  const empty = acc.startBlock('text');
  acc.closeBlock(empty);
  const answer = acc.startBlock('text');
  acc.text(answer, 'Hello');
  acc.finish('end_turn');
  const events = acc.drain();

  assert.equal(empty, 0);
  assert.equal(answer, 1);
  assert.deepEqual(
    events.flatMap(e => (e.type === 'block_start' || e.type === 'text_delta' ? [e.index] : [])),
    [0, 1, 1]
  );
  const content = finalMessage(events).content;
  assert.equal(content.length, 2);
  assert.deepEqual(content[answer], { type: 'text', text: 'Hello' });
});

test('finish reports partial content and error details', () => {
  const acc = new ResponseAccumulator('m', () => 0);
  const index = acc.startBlock('tool_use', { toolUseId: 'call_1', toolName: 'bash' });
  acc.toolInput(index, '{"cmd":');
  acc.finish('aborted');
  const message = finalMessage(acc.drain());
  assert.equal(message.stopReason, 'aborted');
  assert.deepEqual(message.content, [{ type: 'tool_use', id: 'call_1', name: 'bash', input: {} }]);

  const failed = new ResponseAccumulator('m', () => 0);
  failed.finish('error', { code: 'unknown', message: 'boom' });
  assert.deepEqual(finalMessage(failed.drain()).error, { code: 'unknown', message: 'boom' });
});

test('HTTP and network failures map to retryable or terminal LlmError codes', () => {
  const cases: Array<[ReturnType<typeof llmErrorFromHttp>, string, boolean]> = [
    [llmErrorFromHttp(429, 'slow'), 'rate_limited', true],
    [llmErrorFromHttp(529, 'busy'), 'overloaded', true],
    [llmErrorFromHttp(401, 'key'), 'auth', false],
    [llmErrorFromHttp(400, 'prompt is too long: 300000 tokens'), 'context_overflow', false],
    [llmErrorFromHttp(400, 'bad field'), 'invalid_request', false],
    [llmErrorFromHttp(500, 'oops'), 'unknown', true],
    [llmErrorFromHttp(undefined, 'no status'), 'unknown', false],
    [llmNetworkError('reset'), 'network', true],
  ];
  for (const [error, code, retryable] of cases) {
    assert.ok(error instanceof LlmError);
    assert.equal(error.code, code);
    assert.equal(error.retryable, retryable);
  }
});
