import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorResponse, HttpError, jsonObject } from './http.ts';

test('server failures are masked and carry a request id, client errors keep their message', async () => {
  const masked = errorResponse(new Error('database password leaked'));
  assert.equal(masked.status, 500);
  const maskedBody = (await masked.json()) as { error: string; requestId: string };
  assert.equal(maskedBody.error, 'The request could not be completed');
  assert.ok(maskedBody.requestId);
  const notFound = errorResponse(new HttpError('Conversation not found', 404));
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { error: 'Conversation not found' });
});

test('jsonObject accepts only bounded JSON objects', async () => {
  const post = (body: string) => new Request('http://localhost/', { method: 'POST', body });
  assert.deepEqual(await jsonObject(post('{"text":"hi"}')), { text: 'hi' });
  assert.equal(await jsonObject(post('[1]')), null);
  assert.equal(await jsonObject(post('not json')), null);
  assert.equal(await jsonObject(post('{"text":"hi"}'), 4), null);
});
