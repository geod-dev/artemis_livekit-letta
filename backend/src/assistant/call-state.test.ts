import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallStateFilter, stripCallState } from './messages.ts';

function run(chunks: string[]) {
  const filter = new CallStateFilter();
  const spoken = chunks.map((c) => filter.push(c)).join('') + filter.flush();
  return { spoken, state: filter.state };
}

test('a trailing marker is removed and becomes the response state', () => {
  assert.deepEqual(run(['Where and ', 'when? [lis', 'ten]']), {
    spoken: 'Where and when?',
    state: 'listen',
  });
  assert.deepEqual(run(['Paris.', ' [done]']), { spoken: 'Paris.', state: 'done' });
});

test('the last marker wins and markers are never spoken', () => {
  assert.deepEqual(run(['On it. [done]', ' Actually, which city? [listen]']), {
    spoken: 'On it. Actually, which city?',
    state: 'listen',
  });
});

test('brackets that are not markers are kept', () => {
  assert.deepEqual(run(['See [1', '] and [d']), { spoken: 'See [1] and [d', state: null });
});

test('stored text is shown without markers', () => {
  assert.equal(stripCallState('Sure, what time? [listen]'), 'Sure, what time?');
});
