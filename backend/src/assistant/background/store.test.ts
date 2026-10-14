import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackgroundStoreLoadError,
  configureBackgroundStorage,
  snapshot,
  transact,
  type BackgroundStoragePort,
  type UpdateRecord,
} from './store.ts';

class MemoryStorage implements BackgroundStoragePort {
  contents: string | null = '{ definitely not json';
  writes = 0;
  failWrites = false;
  read(): string | null { return this.contents; }
  async writeAtomic(contents: string): Promise<void> {
    if (this.failWrites) throw new Error('disk full');
    this.contents = contents;
    this.writes++;
  }
}

const storage = new MemoryStorage();
configureBackgroundStorage(storage);

test('corrupt state is reported and never overwritten; legacy state migrates', async () => {
  assert.throws(() => snapshot(), BackgroundStoreLoadError);
  assert.equal(storage.writes, 0);
  storage.contents = JSON.stringify({ origins: {}, updates: {}, seen: [] });
  configureBackgroundStorage(storage);
  assert.equal(snapshot().version, 3);
  await transact((draft) => { draft.seen.push('saved'); });
  assert.equal(JSON.parse(storage.contents!).version, 3);
});

test('pruning keeps held and unread updates even above the soft cap', async () => {
  const makeUpdate = (id: string, delivery: UpdateRecord['delivery'], unread: boolean): UpdateRecord => ({
    id, conversationId: 'c', title: id, status: 'completed', needsInput: false, report: '', depth: 0,
    delivery, unread, createdAt: new Date(0).toISOString(),
  });
  await transact((draft) => {
    for (let i = 0; i < 305; i++) {
      const id = `u-${i}`;
      draft.updates[id] = makeUpdate(id, i < 3 ? 'delivered' : 'held', i !== 0);
    }
  });
  const result = snapshot().updates;
  assert.equal(result['u-0'], undefined);
  assert.ok(result['u-1']);
  assert.ok(result['u-304']);
  assert.equal(Object.keys(result).length, 304);
});

test('failed persistence leaves the in-memory state unchanged', async () => {
  storage.failWrites = true;
  await assert.rejects(transact((draft) => { draft.seen.push('not-committed'); }));
  assert.equal(snapshot().seen.includes('not-committed'), false);
  storage.failWrites = false;
});
