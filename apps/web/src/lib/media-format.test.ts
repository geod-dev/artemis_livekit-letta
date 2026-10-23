import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFileSize, formatMediaDuration } from './media-format.ts';

test('formats finite byte counts with binary units and guards invalid sizes', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1024 ** 2), '1.0 MB');
  assert.equal(formatFileSize(1024 ** 3), '1.0 GB');
  assert.equal(formatFileSize(Number.NaN), '—');
  assert.equal(formatFileSize(-1), '—');
});

test('formats valid durations and returns a placeholder for invalid values', () => {
  assert.equal(formatMediaDuration(0), '0:00');
  assert.equal(formatMediaDuration(61.9), '1:01');
  assert.equal(formatMediaDuration(Number.POSITIVE_INFINITY), '--:--');
  assert.equal(formatMediaDuration(-2), '--:--');
});
