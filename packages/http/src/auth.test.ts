import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasBearer } from './auth.ts';

function request(authorization?: string): Request {
  return new Request('http://localhost/v1/x', authorization === undefined ? {} : { headers: { authorization } });
}

test('hasBearer accepts the exact token with any case of the scheme', () => {
  assert.equal(hasBearer(request('Bearer s3cret'), 's3cret'), true);
  assert.equal(hasBearer(request('bearer s3cret'), 's3cret'), true);
});

test('hasBearer rejects a wrong token of equal or different length', () => {
  assert.equal(hasBearer(request('Bearer s3crex'), 's3cret'), false);
  assert.equal(hasBearer(request('Bearer s3cret-and-more'), 's3cret'), false);
  assert.equal(hasBearer(request('Bearer s3'), 's3cret'), false);
});

test('hasBearer rejects a missing header, a bare token and an empty presented value', () => {
  assert.equal(hasBearer(request(), 's3cret'), false);
  assert.equal(hasBearer(request('s3cret'), 's3cret'), false);
  assert.equal(hasBearer(request('Bearer '), 's3cret'), false);
  assert.equal(hasBearer(request('Basic s3cret'), 's3cret'), false);
});

test('hasBearer never matches an empty expected token', () => {
  assert.equal(hasBearer(request('Bearer '), ''), false);
  assert.equal(hasBearer(request('Bearer x'), ''), false);
});
