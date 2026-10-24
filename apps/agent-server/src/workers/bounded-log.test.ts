import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoundedLog } from './bounded-log.ts';

test('keeps text whole while it fits the limit', () => {
  const log = new BoundedLog(100);
  log.append('abc');
  log.append('');
  log.append('def');
  assert.equal(log.toString(), 'abcdef');
});

test('drops the oldest pieces behind a notice and keeps the newest text', () => {
  const log = new BoundedLog(10);
  log.append('abcdef');
  log.append('ghijkl');
  assert.equal(log.toString(), '[output truncated: 6 bytes omitted]\nghijkl');
});

test('trims a single oversized piece to its newest bytes', () => {
  const log = new BoundedLog(4);
  log.append('abcdefgh');
  assert.equal(log.toString(), '[output truncated: 4 bytes omitted]\nefgh');
});
