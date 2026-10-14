import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveForkWithRouting, RecoverableForkArchiveError } from './lifecycle.ts';

test('fork routing is installed before source archive and a failed archive returns a recoverable fork', async () => {
  const order: string[] = [];
  const fork = { id: 'visible-fork' };
  let error: unknown;
  try {
    await archiveForkWithRouting(
      fork,
      async () => { order.push('route'); },
      async () => { order.push('archive'); throw new Error('provider unavailable'); }
    );
  } catch (caught) {
    error = caught;
  }
  assert.deepEqual(order, ['route', 'archive']);
  assert.ok(error instanceof RecoverableForkArchiveError);
  assert.equal(error.conversation, fork);
  assert.equal((error.cause as Error).message, 'provider unavailable');
});
