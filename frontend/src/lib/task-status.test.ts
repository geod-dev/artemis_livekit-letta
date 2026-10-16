import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTaskDuration, taskStatusLabel, workedFor } from './task-status.ts';

test('agent durations use compact seconds, minutes, and hours', () => {
  for (const [ms, expected] of [
    [0, '0s'],
    [20000, '20s'],
    [92000, '1min32s'],
    [59600, '1min'],
    [3600000, '1h'],
    [3692000, '1h1min32s'],
  ] as const) {
    assert.equal(formatTaskDuration(ms), expected);
  }
  for (const missing of [undefined, -1, NaN, Infinity])
    assert.equal(formatTaskDuration(missing), null);
});

test('all agent surfaces share terminal status labels without inventing unknown durations', () => {
  assert.equal(taskStatusLabel({ status: 'completed', durationMs: 20000 }), 'Done in 20s');
  assert.equal(taskStatusLabel({ status: 'completed', durationMs: 92000 }), 'Done in 1min32s');
  assert.equal(taskStatusLabel({ status: 'completed' }), 'Done');
  assert.equal(taskStatusLabel({ status: 'failed', durationMs: 20000 }), 'Failed after 20s');
  assert.equal(taskStatusLabel({ status: 'cancelled', durationMs: 20000 }), 'Stopped after 20s');
  assert.equal(taskStatusLabel({ status: 'running', durationMs: 20000 }), 'Running');
});

test('worked duration wording is compact and does not invent missing timings', () => {
  assert.equal(workedFor(11082), 'Worked for 11s');
  assert.equal(workedFor(0), 'Worked for 0s');
  assert.equal(workedFor(92000), 'Worked for 1min32s');
  assert.equal(workedFor(undefined), 'Worked');
});
