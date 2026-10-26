import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fileInfo } from './use-file-info.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('HEAD 404 is reported as missing', async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  assert.deepEqual(await fileInfo('check/404.txt'), { status: 'missing' });
});

test('HEAD 502 is not reported as missing', async () => {
  globalThis.fetch = async () => new Response(null, { status: 502 });
  assert.deepEqual(await fileInfo('check/502.txt'), { status: 'error' });
});

test('a failed HEAD request is not reported as missing', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  assert.deepEqual(await fileInfo('check/offline.txt'), { status: 'error' });
});

test('HEAD 200 reports the type and size', async () => {
  globalThis.fetch = async () =>
    new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': '12' },
    });
  assert.deepEqual(await fileInfo('check/ok.txt'), {
    status: 'ready',
    type: 'text/plain',
    size: 12,
  });
});
