import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prefixedId, uuid } from './ids.ts';

test('prefixed ids start with the prefix and carry 32 hex characters', () => {
  const id = prefixedId('task');
  assert.match(id, /^task_[0-9a-f]{32}$/);
});

test('ids are unique', () => {
  const ids = new Set(Array.from({ length: 100 }, () => prefixedId('turn')));
  assert.equal(ids.size, 100);
});

test('uuid returns a canonical v4 uuid', () => {
  assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
