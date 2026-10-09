import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayKey, dayLabel } from './message-days.ts';

const now = new Date(2026, 9, 7, 10, 30); // Wednesday, Oct 7 2026

test('keys a date by its local calendar day', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(dayKey(new Date(2026, 0, 5, 0, 0)), '2026-01-05');
});

test('names recent days relative to today', () => {
  assert.equal(dayLabel('2026-10-07', now), 'Today');
  assert.equal(dayLabel('2026-10-06', now), 'Yesterday');
  assert.equal(
    dayLabel('2026-10-03', now),
    new Date(2026, 9, 3).toLocaleDateString(undefined, { weekday: 'long' })
  );
});

test('names older days by date, with the year only when it differs', () => {
  assert.doesNotMatch(dayLabel('2026-09-01', now), /2026/);
  assert.match(dayLabel('2025-12-31', now), /2025/);
});
