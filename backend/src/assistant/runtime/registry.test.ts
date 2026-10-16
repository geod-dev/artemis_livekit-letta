import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntimeRegistry } from './registry.ts';

test('a closed failed session is replaced immediately for the next request', () => {
  let created = 0;
  const registry = createRuntimeRegistry(() => ({
    sequence: ++created,
    isBusy: false,
    isClosed: false as boolean,
    lastUsed: Date.now(),
    async close() {
      this.isClosed = true;
    },
  }));
  const failed = registry.get('conversation');
  failed.isClosed = true;
  const recovered = registry.get('conversation');
  assert.notEqual(recovered, failed);
  assert.equal(recovered.sequence, 2);
  assert.equal(registry.get('conversation'), recovered);
});

test('mutation tombstone keeps a closed runtime from reopening while archive is in progress', async () => {
  let closes = 0;
  const registry = createRuntimeRegistry((id) => ({
    id,
    isBusy: false,
    lastUsed: Date.now(),
    async close() {
      closes++;
    },
  }));
  registry.get('conversation');
  let release!: () => void;
  const mutation = registry.withMutation(
    'conversation',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  await Promise.resolve();
  const newlyRequested = registry.get('conversation');
  assert.equal(newlyRequested.isBusy, false);
  await Promise.resolve();
  release();
  await mutation;
  assert.equal(closes, 1);
});

test('closeAll stops idle cleanup and drains all sessions', async () => {
  let closes = 0;
  const registry = createRuntimeRegistry(() => ({
    isBusy: true,
    lastUsed: Date.now(),
    async close() {
      closes++;
    },
  }));
  registry.get('one');
  registry.get('two');
  registry.startIdleCleanup(1, 60_000);
  await registry.closeAll();
  assert.equal(closes, 2);
});
