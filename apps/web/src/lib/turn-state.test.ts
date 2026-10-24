import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTaskEvent,
  endTurn,
  snapshotTasks,
  snapshotTurnIds,
  startTurn,
} from './turn-state.ts';

test('a started turn is listed once, in start order', () => {
  assert.deepEqual(startTurn(['a'], 'b'), ['a', 'b']);
  const turns = ['a', 'b'];
  assert.equal(startTurn(turns, 'a'), turns);
});

test('a settled turn leaves the active list', () => {
  assert.deepEqual(endTurn(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(endTurn(['a'], 'missing'), ['a']);
});

test('a snapshot lists each active turn once and keeps only running tasks', () => {
  assert.deepEqual(
    snapshotTurnIds([{ turnId: 't1' }, { turnId: 't1' }, { turnId: 't2' }] as never),
    ['t1', 't2']
  );
  assert.deepEqual(
    snapshotTasks([
      { taskId: 'k1', title: 'Index', status: 'running' },
      { taskId: 'k2', title: 'Done', status: 'completed' },
    ] as never),
    [{ id: 'k1', title: 'Index', status: 'running' }]
  );
});

test('a running task event replaces the earlier entry of the same task', () => {
  const tasks = [{ id: 'k1', title: 'Old', status: 'running' as const }];
  assert.deepEqual(
    applyTaskEvent(tasks, {
      type: 'task',
      taskId: 'k1',
      title: 'New',
      status: 'running',
      kind: 'command',
    } as never),
    [{ id: 'k1', title: 'New', status: 'running', kind: 'command' }]
  );
});

test('a task that is no longer running leaves the list', () => {
  const tasks = [
    { id: 'k1', title: 'One', status: 'running' as const },
    { id: 'k2', title: 'Two', status: 'running' as const },
  ];
  assert.deepEqual(
    applyTaskEvent(tasks, { type: 'task', taskId: 'k1', title: 'One', status: 'done' } as never),
    [{ id: 'k2', title: 'Two', status: 'running' }]
  );
});
