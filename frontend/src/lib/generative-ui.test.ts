import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { presentLibrary, presentToolSchema, presentTree, replyMessage } from './generative-ui.ts';

// Without the schema's shared-prop warnings (see `presentToolSchema`).
process.env.NODE_ENV = 'production';

test('the backend registers the present tool generated from the library', () => {
  const registered: unknown = JSON.parse(
    readFileSync(
      new URL('../../../backend/src/assistant/present-tool.json', import.meta.url),
      'utf8'
    )
  );
  const generated: unknown = JSON.parse(
    JSON.stringify(presentToolSchema(presentLibrary(() => null)))
  );
  assert.deepEqual(registered, generated, 'run `pnpm generate:present-tool` in frontend/');
});

test('children sent as a JSON string are read as components', () => {
  const chart = { $type: 'Chart', variant: 'bar', data: [{ label: 'Mon', value: 5 }] };
  const button = { $type: 'Button', label: 'Keep', $action: { type: 'reply', text: 'Keep' } };
  const tree = {
    $type: 'Card',
    title: 'Plan',
    children: JSON.stringify([chart, { $type: 'Row', children: JSON.stringify(button) }]),
  };
  assert.deepEqual(presentTree(tree), {
    $type: 'Card',
    title: 'Plan',
    children: [chart, { $type: 'Row', children: button }],
  });
});

test('text children stay text', () => {
  for (const text of ['Hello', '[1] a note', '{not json', '[1, 2]', '{"a": 1}']) {
    assert.deepEqual(presentTree({ $type: 'Card', children: text }), {
      $type: 'Card',
      children: text,
    });
  }
});

test('a reply sends its text', () => {
  assert.equal(replyMessage({ type: 'reply', text: ' Book the 9:00 slot ' }), 'Book the 9:00 slot');
});

test('a reply adds the value of the control that fired it', () => {
  assert.equal(replyMessage({ type: 'reply', text: 'Size', $input: 'M' }), 'Size\nM');
  assert.equal(replyMessage({ type: 'reply', $input: ['red', 'blue'] }), 'red, blue');
  assert.equal(replyMessage({ type: 'reply', $input: 4 }), '4');
});

test('a form reply lists its fields, without the empty ones', () => {
  assert.equal(
    replyMessage({
      type: 'reply',
      text: 'My trip',
      $input: { from: 'Paris', nights: '3', note: '', extras: ['bike'], early: false },
    }),
    'My trip\nfrom: Paris\nnights: 3\nextras: bike\nearly: false'
  );
});

test('a reply without text or input is empty', () => {
  assert.equal(replyMessage({ type: 'reply' }), '');
});
