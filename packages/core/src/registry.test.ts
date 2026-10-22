import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Clock } from './clock.ts';
import type { Logger } from './logger.ts';
import { type Reapable, KeyedRegistry } from './registry.ts';

/** Manual clock: time moves only through `advance`, which fires due intervals in order. */
class FakeClock implements Clock {
  time = 0;
  private readonly timers: { at: number; every: number; fn: () => void; cancelled: boolean }[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    return this.schedule(fn, ms, 0);
  }

  setInterval(fn: () => void, ms: number): { cancel(): void } {
    return this.schedule(fn, ms, ms);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const next = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.time = next.at;
      if (next.every > 0) next.at += next.every;
      else next.cancelled = true;
      next.fn();
    }
    this.time = target;
  }

  activeTimers(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }

  private schedule(fn: () => void, ms: number, every: number) {
    const timer = { at: this.time + ms, every, fn, cancelled: false };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }
}

class FakeEntry implements Reapable {
  activeFlag = false;
  disposed: string[] = [];
  private activity: number;
  /** When set, `dispose` waits for this promise before completing. */
  gate?: Promise<void>;

  constructor(
    readonly key: string,
    private readonly clock: FakeClock
  ) {
    this.activity = clock.now();
  }

  touch(): void {
    this.activity = this.clock.now();
  }

  isActive(): boolean {
    return this.activeFlag;
  }

  lastActivityAt(): number {
    return this.activity;
  }

  async dispose(reason: string): Promise<void> {
    await this.gate;
    this.disposed.push(reason);
  }
}

function setup(options: { idleMs?: number; sweepEveryMs?: number; logger?: Logger } = {}) {
  const clock = new FakeClock();
  const created: FakeEntry[] = [];
  const disposed: { key: string; reason: string }[] = [];
  const registry = new KeyedRegistry<FakeEntry>({
    create: async (key) => {
      const entry = new FakeEntry(key, clock);
      created.push(entry);
      return entry;
    },
    idleMs: options.idleMs ?? 120_000,
    sweepEveryMs: options.sweepEveryMs ?? 15_000,
    clock,
    onDisposed: (key, reason) => disposed.push({ key, reason }),
    logger: options.logger,
  });
  return { clock, created, disposed, registry };
}

test('concurrent gets for one key create the entry once', async () => {
  const { created, registry } = setup();
  const [first, second] = await Promise.all([registry.get('a'), registry.get('a')]);
  assert.equal(first, second);
  assert.equal(created.length, 1);
  assert.deepEqual(registry.keys(), ['a']);
  assert.equal(registry.peek('a'), first);
});

test('a failed create is not cached and the next get tries again', async () => {
  let attempts = 0;
  const clock = new FakeClock();
  const registry = new KeyedRegistry<FakeEntry>({
    create: async (key) => {
      attempts++;
      if (attempts === 1) throw new Error('boot failed');
      return new FakeEntry(key, clock);
    },
    idleMs: 1,
    sweepEveryMs: 1,
    clock,
  });
  await assert.rejects(registry.get('a'), /boot failed/);
  assert.equal(registry.peek('a'), undefined);
  assert.ok(await registry.get('a'));
  assert.equal(attempts, 2);
});

test('sweep reaps idle entries strictly after idleMs and keeps active ones', async () => {
  const { clock, disposed, registry } = setup({ idleMs: 100 });
  const idle = await registry.get('idle');
  const busy = await registry.get('busy');
  busy.activeFlag = true;
  clock.advance(100);
  assert.deepEqual(await registry.sweep(), []);
  clock.advance(1);
  assert.deepEqual(await registry.sweep(), ['idle']);
  assert.deepEqual(registry.keys(), ['busy']);
  assert.deepEqual(idle.disposed, ['idle']);
  assert.deepEqual(disposed, [{ key: 'idle', reason: 'idle' }]);
});

test('activity resets the idle clock and a reaped key respawns as a new entry', async () => {
  const { clock, created, registry } = setup({ idleMs: 100 });
  const first = await registry.get('conv');
  clock.advance(80);
  first.touch();
  clock.advance(80);
  assert.deepEqual(await registry.sweep(), []);
  clock.advance(101);
  assert.deepEqual(await registry.sweep(), ['conv']);
  const respawned = await registry.get('conv');
  assert.notEqual(respawned, first);
  assert.equal(created.length, 2);
  assert.deepEqual(registry.keys(), ['conv']);
});

test('a get during a dispose waits for the tombstone and then recreates the entry', async () => {
  const { created, disposed, registry } = setup();
  const original = await registry.get('conv');
  let release!: () => void;
  original.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closing = registry.dispose('conv', 'archive');
  assert.equal(registry.peek('conv'), undefined);
  let resolved: FakeEntry | undefined;
  const waiting = registry.get('conv').then((entry) => {
    resolved = entry;
    return entry;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(resolved, undefined, 'get must not return the entry being disposed');
  release();
  await closing;
  const recreated = await waiting;
  assert.notEqual(recreated, original);
  assert.equal(created.length, 2);
  assert.deepEqual(original.disposed, ['archive']);
  assert.deepEqual(disposed, [{ key: 'conv', reason: 'archive' }]);
});

test('dispose of an unknown key is a no-op', async () => {
  const { disposed, registry } = setup();
  await registry.dispose('missing', 'reason');
  assert.deepEqual(disposed, []);
});

test('start reaps on the reaper period and close stops it and disposes everything', async () => {
  const { clock, registry } = setup({ idleMs: 50, sweepEveryMs: 10 });
  const entry = await registry.get('a');
  registry.start();
  registry.start();
  assert.equal(clock.activeTimers(), 1, 'start is idempotent');
  clock.advance(60);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(registry.keys(), []);
  assert.deepEqual(entry.disposed, ['idle']);

  const other = await registry.get('b');
  await registry.close();
  assert.equal(clock.activeTimers(), 0);
  assert.deepEqual(other.disposed, ['shutdown']);
  assert.deepEqual(registry.keys(), []);
});

test('sweep logs a failing dispose and still reaps the other idle entries', async () => {
  const errors: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error(message, fields) {
      errors.push({ message, fields });
    },
    child() {
      return logger;
    },
  };
  const { clock, registry } = setup({ idleMs: 10, logger });
  const broken = await registry.get('broken');
  const healthy = await registry.get('healthy');
  broken.dispose = async () => {
    throw new Error('disk gone');
  };
  clock.advance(11);
  assert.deepEqual(await registry.sweep(), ['broken', 'healthy']);
  assert.deepEqual(healthy.disposed, ['idle']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.fields?.key, 'broken');
  assert.match(String(errors[0]?.fields?.error), /disk gone/);
});
