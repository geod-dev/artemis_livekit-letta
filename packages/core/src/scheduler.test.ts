import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BusyError } from './errors.ts';
import { SerialScheduler } from './scheduler.ts';

test('scheduler runs jobs in order and continues after a failed job', async () => {
  const scheduler = new SerialScheduler();
  const order: number[] = [];
  let release!: () => void;
  const first = scheduler.run(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    order.push(1);
  });
  const failed = scheduler.run(async () => {
    order.push(2);
    throw new Error('expected');
  });
  const last = scheduler.run(async () => {
    order.push(3);
  });
  await Promise.resolve();
  assert.deepEqual(order, []);
  release();
  await first;
  await assert.rejects(failed, /expected/);
  await last;
  await scheduler.drain();
  assert.deepEqual(order, [1, 2, 3]);
});

test('scheduler resolves with the job result and counts queued and running jobs', async () => {
  const scheduler = new SerialScheduler();
  assert.equal(scheduler.idle, true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = scheduler.run(async () => {
    await gate;
    return 'done';
  });
  const second = scheduler.run(async () => 42);
  assert.equal(scheduler.pending, 2);
  assert.equal(scheduler.idle, false);
  release();
  assert.equal(await blocked, 'done');
  assert.equal(await second, 42);
  await scheduler.drain();
  assert.equal(scheduler.pending, 0);
  assert.equal(scheduler.idle, true);
});

test('scheduler rejects with BusyError beyond maxPending and accepts again once settled', async () => {
  const scheduler = new SerialScheduler(2);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = scheduler.run(() => gate);
  const second = scheduler.run(async () => 'second');
  await assert.rejects(
    scheduler.run(async () => 'overflow'),
    (error: unknown) => error instanceof BusyError && error.status === 429
  );
  assert.equal(scheduler.pending, 2);
  release();
  await first;
  assert.equal(await second, 'second');
  assert.equal(await scheduler.run(async () => 'later'), 'later');
});

test('drain resolves only after every job queued before it has settled', async () => {
  const scheduler = new SerialScheduler();
  const finished: string[] = [];
  void scheduler.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    finished.push('slow');
  });
  void scheduler.run(async () => {
    throw new Error('ignored');
  }).catch(() => undefined);
  await scheduler.drain();
  assert.deepEqual(finished, ['slow']);
});
