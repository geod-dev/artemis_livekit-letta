import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, ConflictError, NotFoundError } from '@artemis/core';
import { HttpError, errorResponse, jsonObject } from './errors.ts';

test('AppError and HttpError keep their status and code; the message is shown below 500', async (t) => {
  t.mock.method(console, 'error', () => {});
  const notFound = errorResponse(new NotFoundError('conversation'));
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { error: 'conversation not found', code: 'not_found' });

  const conflict = errorResponse(new ConflictError('stale_revision', 'Settings changed'));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'Settings changed', code: 'stale_revision' });

  const teapot = errorResponse(new HttpError(418, 'short and stout', 'teapot'));
  assert.equal(teapot.status, 418);
  assert.deepEqual(await teapot.json(), { error: 'short and stout', code: 'teapot' });
});

test('5xx errors hide their message, carry a request id and log the stack', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const response = errorResponse(new Error('database password leaked'));
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string; requestId: string };
  assert.equal(body.error, 'The request could not be completed');
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(JSON.stringify(logged.mock.calls[0]?.arguments), /database password leaked/);
});

test('an AppError with a 5xx status is hidden too', async (t) => {
  t.mock.method(console, 'error', () => {});
  const response = errorResponse(new AppError('upstream_down', 'provider unreachable', 503));
  assert.equal(response.status, 503);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.error, 'The request could not be completed');
  assert.equal(body.code, 'upstream_down');
  assert.equal(typeof body.requestId, 'string');
});

test('plain errors use the fallback status; invalid fallbacks become 500', async (t) => {
  t.mock.method(console, 'error', () => {});
  const unprocessable = errorResponse(new Error('bad field'), 422);
  assert.equal(unprocessable.status, 422);
  assert.deepEqual(await unprocessable.json(), { error: 'bad field' });

  const coerced = errorResponse('boom', 200);
  assert.equal(coerced.status, 500);
  assert.equal(((await coerced.json()) as { error: string }).error, 'The request could not be completed');
});

test('jsonObject returns only JSON objects', async () => {
  const post = (body: string) => new Request('http://localhost/x', { method: 'POST', body });
  assert.deepEqual(await jsonObject(post('{"text":"hi","n":1}')), { text: 'hi', n: 1 });
  assert.equal(await jsonObject(post('[1,2]')), null);
  assert.equal(await jsonObject(post('"plain"')), null);
  assert.equal(await jsonObject(post('{not json')), null);
  assert.equal(await jsonObject(post('')), null);
});

test('jsonObject rejects bodies over the limit with or without a Content-Length', async () => {
  const declared = new Request('http://localhost/x', {
    method: 'POST',
    headers: { 'content-length': '999' },
    body: '{"a":1}',
  });
  assert.equal(await jsonObject(declared, 10), null);

  const streamed = new Request('http://localhost/x', { method: 'POST', body: `{"a":"${'x'.repeat(40)}"}` });
  assert.equal(await jsonObject(streamed, 10), null);

  const small = new Request('http://localhost/x', { method: 'POST', body: '{"a":1}' });
  assert.deepEqual(await jsonObject(small, 10), { a: 1 });
});
