import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, BusyError, ConflictError, errorMessage, NotFoundError } from './errors.ts';

test('subclasses keep their own name, code and status', () => {
  const notFound = new NotFoundError('Conversation');
  assert.equal(notFound.name, 'NotFoundError');
  assert.equal(notFound.message, 'Conversation not found');
  assert.equal(notFound.code, 'not_found');
  assert.equal(notFound.status, 404);

  const conflict = new ConflictError('stale_revision', 'Changed elsewhere');
  assert.equal(conflict.name, 'ConflictError');
  assert.equal(conflict.status, 409);

  const busy = new BusyError();
  assert.equal(busy.name, 'BusyError');
  assert.equal(busy.code, 'busy');
  assert.equal(busy.status, 429);
});

test('a plain AppError defaults to status 500', () => {
  const error = new AppError('boom', 'Something broke');
  assert.equal(error.name, 'AppError');
  assert.equal(error.status, 500);
  assert.ok(error instanceof Error);
});

test('errorMessage returns an Error message or the string form of any other value', () => {
  assert.equal(errorMessage(new Error('failed')), 'failed');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(42), '42');
  assert.equal(errorMessage(undefined), 'undefined');
});
