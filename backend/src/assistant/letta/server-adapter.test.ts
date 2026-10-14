import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppServerResponseFrame } from './server-adapter.ts';

test('the app-server adapter accepts only correlated protocol object frames', () => {
  assert.equal(isAppServerResponseFrame({ type: 'read_file_response', request_id: 'req-1' }), true);
  assert.equal(isAppServerResponseFrame({ type: 'read_file_response' }), false);
  assert.equal(isAppServerResponseFrame([{ type: 'read_file_response', request_id: 'req-1' }]), false);
  assert.equal(isAppServerResponseFrame(null), false);
});
