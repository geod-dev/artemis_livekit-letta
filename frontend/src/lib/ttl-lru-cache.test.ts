import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TtlLruCache } from './ttl-lru-cache.ts';

test('expires entries and refreshes their lifetime on set', () => {
  let now = 0;
  const cache = new TtlLruCache<string, number>(2, 10, () => now);
  cache.set('a', 1);
  now = 9;
  assert.equal(cache.get('a'), 1);
  now = 20;
  assert.equal(cache.get('a'), undefined);
});

test('evicts the least recently used entry at the size limit', () => {
  const cache = new TtlLruCache<string, number>(2, 100);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
});
