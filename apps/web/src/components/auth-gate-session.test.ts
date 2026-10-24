import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SESSION_UNREACHABLE, sessionCheckFailure } from './auth-gate-session.ts';

test('an expired session signs out without a message', () => {
  assert.deepEqual(sessionCheckFailure({ status: 401 }, true), { signOut: true, error: '' });
  assert.deepEqual(sessionCheckFailure({ status: 401 }, false), { signOut: true, error: '' });
});

test('a running chat stays mounted through a temporary outage', () => {
  assert.deepEqual(sessionCheckFailure(new Error('offline'), true), {
    signOut: false,
    error: SESSION_UNREACHABLE,
  });
});

test('an unreachable server at sign-in shows the connection error and the sign-in form', () => {
  assert.deepEqual(sessionCheckFailure({ status: 503 }, false), {
    signOut: true,
    error: SESSION_UNREACHABLE,
  });
  assert.deepEqual(sessionCheckFailure(undefined, false), {
    signOut: true,
    error: SESSION_UNREACHABLE,
  });
});
