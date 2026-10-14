import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SerialScheduler } from './scheduler.ts';

test('session scheduler runs jobs in order and continues after a failed job', async () => {
  const scheduler = new SerialScheduler();
  const order: number[] = [];
  let release!: () => void;
  const first = scheduler.schedule(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    order.push(1);
  });
  const failed = scheduler.schedule(async () => {
    order.push(2);
    throw new Error('expected');
  });
  const last = scheduler.schedule(async () => {
    order.push(3);
  });
  await Promise.resolve();
  assert.deepEqual(order, []);
  release();
  await first;
  await assert.rejects(failed, /expected/);
  await last;
  await scheduler.idle();
  assert.deepEqual(order, [1, 2, 3]);
});
