import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentOutcome, unknownComponents } from './present';

test('a tree of known components is shown', () => {
  const tree = {
    $type: 'Card',
    title: 'Q3',
    children: [
      { $type: 'Row', children: [{ $type: 'Fact', label: 'Growth', value: '+18%' }] },
      'plain text',
    ],
  };
  assert.deepEqual(unknownComponents(tree), []);
  assert.deepEqual(presentOutcome(tree), {
    text: 'Shown to the user in the chat.',
    isError: false,
  });
});

test('components in children sent as a JSON string are checked', () => {
  const tree = {
    $type: 'Card',
    children: JSON.stringify([{ $type: 'Chart', variant: 'bar' }, { $type: 'Grid' }]),
  };
  assert.deepEqual(unknownComponents(tree), ['Grid']);
  assert.deepEqual(unknownComponents({ $type: 'Text', children: '[1] a note' }), []);
});

test('unknown components and nodes without a type are reported', () => {
  const tree = { $type: 'Grid', children: [{ $type: 'Card', children: { title: 'x' } }] };
  assert.deepEqual(unknownComponents(tree), ['Grid', '(missing $type)']);
  const outcome = presentOutcome(tree);
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /unknown components Grid, \(missing \$type\)\. Use only: Header, /);
});
