import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentOutcome, unknownComponents } from './present';

test('a tree with known components and valid props is shown', () => {
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

test('serialized component children are decoded and checked', () => {
  const tree = {
    $type: 'Card',
    children: JSON.stringify([{ $type: 'Chart', variant: 'bar' }, { $type: 'Grid' }]),
  };
  assert.match(unknownComponents(tree)[0], /component name or its properties/);
  assert.deepEqual(unknownComponents({ $type: 'Text', value: '[1] a note' }), []);
});

test('root must be one component object', () => {
  for (const input of [null, 'text', 4, true, [], [{ $type: 'Text', value: 'hi' }]]) {
    const outcome = presentOutcome(input);
    assert.equal(outcome.isError, true);
    assert.match(outcome.text, /root must be one component object/);
  }
});

test('per-component property schemas reject invalid and unknown properties', () => {
  assert.match(
    unknownComponents({ $type: 'Text', value: 3 })[0],
    /component name or its properties/
  );
  assert.match(
    unknownComponents({ $type: 'Text', value: 'ok', onclick: 'run' })[0],
    /component name or its properties/
  );
  assert.match(unknownComponents({ $type: 'Missing' })[0], /component name or its properties/);
});

test('only the registered reply action is accepted', () => {
  assert.deepEqual(
    unknownComponents({
      $type: 'Button',
      label: 'Continue',
      $action: { type: 'reply', text: 'continue' },
    }),
    []
  );
  assert.match(
    unknownComponents({ $type: 'Button', label: 'Run', $action: { type: 'run-code' } })[0],
    /Only the reply action/
  );
  assert.match(
    unknownComponents({
      $type: 'Button',
      label: 'Run',
      $action: { type: 'reply', callback: 'x' },
    })[0],
    /Only the reply action/
  );
  assert.match(
    unknownComponents({ $type: 'Text', value: 'Plain', $action: { type: 'reply' } })[0],
    /Only the reply action/
  );
});

test('unsafe image URLs and malformed serialized component children are rejected', () => {
  assert.match(
    unknownComponents({ $type: 'Image', src: 'javascript:alert(1)', alt: 'unsafe' })[0],
    /image URL/
  );
  assert.match(
    unknownComponents({ $type: 'Box', background: 'url(javascript:alert(1))' })[0],
    /unsafe CSS value/
  );
  assert.match(
    unknownComponents({ $type: 'Card', children: '{"$type":' })[0],
    /serialized component children are malformed/i
  );
});

test('depth and serialized child byte limits are enforced', () => {
  let tree: Record<string, unknown> = { $type: 'Text', value: 'end' };
  for (let i = 0; i < 40; i += 1) tree = { $type: 'Col', children: tree };
  assert.match(unknownComponents(tree)[0], /too deep/);
  assert.match(
    unknownComponents({ $type: 'Card', children: `[${' '.repeat(64 * 1024)}]` })[0],
    /too large/
  );
});
