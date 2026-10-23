import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError } from '@artemis/core';
import { mapDatabaseError } from './session.ts';

/** Shaped like the `pg` driver's DatabaseError: SQLSTATE in `code`, schema fields on the error itself. */
function pgError(fields: Record<string, string>): Error {
  return Object.assign(new Error(fields.message ?? 'database error'), fields);
}

test('a foreign-key violation is a NotFoundError that names the constraint and table', () => {
  const mapped = mapDatabaseError(
    pgError({
      code: '23503',
      message: 'insert or update on table "messages" violates foreign key constraint "messages_conversation_id_fkey"',
      constraint: 'messages_conversation_id_fkey',
      table: 'messages',
    })
  );

  assert.ok(mapped instanceof NotFoundError);
  assert.match((mapped as Error).message, /messages_conversation_id_fkey/);
  assert.match((mapped as Error).message, /table messages/);
});

test('a foreign-key violation without schema fields still maps to NotFoundError', () => {
  const mapped = mapDatabaseError(pgError({ code: '23503' }));

  assert.ok(mapped instanceof NotFoundError);
  assert.equal((mapped as Error).message, 'referenced row (table unknown, constraint unknown) not found');
});

test('a unique violation stays a ConflictError with the driver detail', () => {
  const mapped = mapDatabaseError(pgError({ code: '23505', detail: 'Key (id)=(1) already exists.' }));

  assert.ok(mapped instanceof ConflictError);
  assert.equal((mapped as Error).message, 'Key (id)=(1) already exists.');
});

test('other errors and non-error values pass through unchanged', () => {
  const syntax = pgError({ code: '22P02', message: 'invalid input syntax for type uuid' });
  assert.equal(mapDatabaseError(syntax), syntax);
  assert.equal(mapDatabaseError('plain'), 'plain');
  assert.equal(mapDatabaseError(null), null);
});
