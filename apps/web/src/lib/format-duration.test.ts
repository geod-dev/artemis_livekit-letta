import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatElapsed, formatPrecise } from './format-duration.ts';

test('elapsed time reads as a tool call shows it', () => {
  assert.equal(formatElapsed(0), '<1s');
  assert.equal(formatElapsed(999), '<1s');
  assert.equal(formatElapsed(1000), '1.0s');
  assert.equal(formatElapsed(9950), '9.9s');
  assert.equal(formatElapsed(12_000), '12s');
  assert.equal(formatElapsed(65_000), '1m 5s');
});

test('terminal duration keeps milliseconds and pads the seconds of a minute', () => {
  assert.equal(formatPrecise(850), '850ms');
  assert.equal(formatPrecise(1500), '1.5s');
  assert.equal(formatPrecise(59_900), '59.9s');
  assert.equal(formatPrecise(65_000), '1m 05s');
});

test('terminal duration treats NaN and negative input as zero', () => {
  assert.equal(formatPrecise(Number.NaN), '0ms');
  assert.equal(formatPrecise(-5), '0ms');
});
