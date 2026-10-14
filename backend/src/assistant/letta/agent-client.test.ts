import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSubagentTranscriptFrame } from './agent-client.ts';

test('the socket adapter drops only object frames with a subagent id', () => {
  assert.equal(isSubagentTranscriptFrame('{"subagent_id":"worker-1"}'), true);
  assert.equal(isSubagentTranscriptFrame('{"subagent_id":42}'), false);
  assert.equal(isSubagentTranscriptFrame('[{"subagent_id":"worker-1"}]'), false);
  assert.equal(isSubagentTranscriptFrame('{broken json'), false);
  assert.equal(isSubagentTranscriptFrame('{"type":"message"}'), false);
});
