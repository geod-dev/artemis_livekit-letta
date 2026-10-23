import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from './testing.ts';

test('FakeClock fires timers only when advanced past them', () => {
  const clock = new FakeClock();
  const start = clock.now();
  const fired: string[] = [];
  clock.setTimeout(() => fired.push('once'), 100);
  const ticker = clock.setInterval(() => fired.push('tick'), 50);
  clock.advance(120);
  assert.equal(clock.now(), start + 120);
  assert.deepEqual(fired, ['tick', 'once', 'tick']);
  ticker.cancel();
  clock.advance(500);
  assert.deepEqual(fired, ['tick', 'once', 'tick']);
});
