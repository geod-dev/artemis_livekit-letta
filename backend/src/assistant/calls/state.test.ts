import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallStateFilter, stripCallState } from '../conversations/messages.ts';

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

test('only an explicit trailing marker is removed', () => {
  assert.deepEqual(run(['On it. [done]', ' Actually, which city? [listen]']), {
    spoken: 'On it. [done] Actually, which city?',
    state: 'listen',
  });
});

test('marker examples at the end become user text when more text follows', () => {
  assert.deepEqual(run(['Example [listen]', ' means wait for an answer']), {
    spoken: 'Example [listen] means wait for an answer',
    state: null,
  });
});

test('brackets that are not markers are kept', () => {
  assert.deepEqual(run(['See [1', '] and [d']), { spoken: 'See [1] and [d', state: null });
});

test('stored text is shown without markers', () => {
  assert.equal(stripCallState('Sure, what time? [listen]'), 'Sure, what time?');
  assert.equal(stripCallState('The token is [done] in my example.'), 'The token is [done] in my example.');
});
