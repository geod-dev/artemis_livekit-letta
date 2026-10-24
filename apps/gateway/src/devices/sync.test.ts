import type { McpServer } from '@artemis/contracts/chat-types';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeviceSync } from './sync';

const device = (name: string) =>
  ({ name, transport: 'http', url: `http://gateway.test/${name}` }) as McpServer;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A device registry the test changes by hand, with the listener hooks the hub offers. */
function registry(initial: McpServer[] = []) {
  let current = initial;
  const listeners: Array<() => Promise<void>> = [];
  return {
    set: (next: McpServer[]) => {
      current = next;
    },
    servers: () => current,
    onChange: (listener: () => Promise<void>) => {
      listeners.push(listener);
    },
    notify: () => Promise.all(listeners.map((listener) => listener())),
  };
}

test('pushes run one at a time, and each carries the device list current when it runs', async () => {
  const devices = registry([device('laptop')]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pushes: string[][] = [];
  const sync = new DeviceSync({
    devices,
    agent: {
      setManagedMcp: async (servers) => {
        pushes.push(servers.map((server) => server.name));
        if (pushes.length === 1) await held;
      },
    },
  });
  const first = sync.push();
  await sleep(5);
  devices.set([device('laptop'), device('desktop')]);
  const second = sync.push();
  await sleep(5);
  assert.deepEqual(pushes, [['laptop']], 'the second push waits for the first');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(pushes, [['laptop'], ['laptop', 'desktop']]);
});

test('a device change pushes the list, and a failed push rejects so the registry can retry', async (t) => {
  t.mock.method(console, 'error', () => {});
  const devices = registry();
  let failing = false;
  const pushes: string[][] = [];
  const sync = new DeviceSync({
    devices,
    agent: {
      setManagedMcp: async (servers) => {
        pushes.push(servers.map((server) => server.name));
        if (failing) throw new Error('agent-server down');
      },
    },
    everyMs: 60_000,
  });
  sync.start();
  await sync.push();
  devices.set([device('laptop')]);
  failing = true;
  await assert.rejects(devices.notify(), /agent-server down/);
  failing = false;
  await devices.notify();
  assert.deepEqual(pushes.at(-1), ['laptop']);
  sync.stop();
});

test('a failed periodic push does not stop the next one', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  let calls = 0;
  const sync = new DeviceSync({
    devices: registry(),
    agent: {
      setManagedMcp: async () => {
        calls++;
        if (calls === 1) throw new Error('agent-server starting');
      },
    },
    everyMs: 5,
  });
  sync.start();
  await sleep(60);
  sync.stop();
  assert.ok(calls >= 2, `expected a periodic push after the failure, got ${calls}`);
  assert.equal(errors.mock.callCount(), 1);
});

test('stop ends the periodic pushes', async () => {
  let calls = 0;
  const sync = new DeviceSync({
    devices: registry(),
    agent: {
      setManagedMcp: async () => {
        calls++;
      },
    },
    everyMs: 5,
  });
  sync.start();
  await sleep(30);
  sync.stop();
  await sleep(20);
  const stopped = calls;
  await sleep(40);
  assert.equal(calls, stopped);
});
