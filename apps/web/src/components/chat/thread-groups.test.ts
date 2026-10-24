import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupThreadList, startOfLocalDay } from './thread-groups.ts';

const today = startOfLocalDay(new Date(2026, 9, 24, 15));
const at = (dayOffset: number, hour = 12) => new Date(2026, 9, 24 + dayOffset, hour);

test('threads group by day, newest first, and keep the runtime order when nothing has a date', () => {
  const items = [
    { id: 'a', title: 'Alpha', lastMessageAt: at(0, 9) },
    { id: 'b', title: 'Beta', lastMessageAt: at(-1) },
    { id: 'c', title: 'Gamma', lastMessageAt: at(-5) },
    { id: 'd', title: 'Delta', lastMessageAt: at(0, 18) },
  ];
  const result = groupThreadList(['a', 'b', 'c', 'd'], items, '', today);
  assert.deepEqual(result.filteredIndices, [0, 1, 2, 3]);
  assert.deepEqual(result.groups, [
    { label: 'Today', indices: [3, 0] },
    { label: 'Yesterday', indices: [1] },
    { label: 'Earlier', indices: [2] },
  ]);
});

test('a search keeps the matching threads only, case-insensitively and trimmed', () => {
  const items = [
    { id: 'a', title: 'Trip planning' },
    { id: 'b', title: 'Recipes' },
    { id: 'c', title: 'trip budget', lastMessageAt: at(-2) },
  ];
  const result = groupThreadList(['a', 'b', 'c'], items, '  TRIP ', today);
  assert.deepEqual(result.filteredIndices, [0, 2]);
  assert.deepEqual(result.groups, [
    { label: 'Today', indices: [0] },
    { label: 'Earlier', indices: [2] },
  ]);
});

test('untitled threads match as New Chat', () => {
  const items = [{ id: 'a' }];
  assert.deepEqual(groupThreadList(['a'], items, 'new chat', undefined).filteredIndices, [0]);
});

test('no groups while the local day start is unknown or no thread has a date', () => {
  const dated = [{ id: 'a', title: 'A', lastMessageAt: at(0) }];
  assert.equal(groupThreadList(['a'], dated, '', undefined).groups, null);
  assert.equal(groupThreadList(['b'], [{ id: 'b', title: 'B' }], '', today).groups, null);
});
