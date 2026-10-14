import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderPaginationError, collectProviderPages } from './pagination.ts';

test('provider pagination returns all pages only after reaching the end', async () => {
  const cursors: Array<string | undefined> = [];
  const values = await collectProviderPages({
    resource: 'conversations',
    pageSize: 2,
    maxPages: 3,
    fetchPage: async (cursor) => {
      cursors.push(cursor);
      return cursor === undefined ? ['a', 'b'] : ['c'];
    },
    cursorFor: (page) => page.at(-1),
  });
  assert.deepEqual(values, ['a', 'b', 'c']);
  assert.deepEqual(cursors, [undefined, 'b']);
});

test('provider pagination rejects repeated cursors instead of returning partial data', async () => {
  await assert.rejects(
    collectProviderPages({
      resource: 'messages',
      pageSize: 2,
      maxPages: 5,
      fetchPage: async () => ['same', 'same'],
      cursorFor: (page) => page.at(-1),
    }),
    (error: unknown) => error instanceof ProviderPaginationError && error.status === 503 && /cursor/.test(error.message),
  );
});

test('provider pagination fails explicitly when its bounded page budget is exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    collectProviderPages({
      resource: 'conversations',
      pageSize: 2,
      maxPages: 2,
      fetchPage: async () => [`${calls++}`, `${calls}`],
      cursorFor: (page) => page.at(-1),
    }),
    (error: unknown) => error instanceof ProviderPaginationError && error.status === 503 && /limit/.test(error.message),
  );
  assert.equal(calls, 2);
});
