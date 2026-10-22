import assert from 'node:assert/strict';
import { test } from 'node:test';
import { depthAfter, wakesThread } from './policy.ts';

test('cancelled or nested work never wakes the conversation', () => {
  assert.equal(wakesThread({ status: 'cancelled', needsInput: true, depth: 0 }, 'text'), false);
  assert.equal(wakesThread({ status: 'failed', needsInput: false, depth: 1 }, 'text'), false);
});

test('failures and input requests always wake it; successes unless started in a short call', () => {
  assert.equal(wakesThread({ status: 'failed', needsInput: false, depth: 0 }, 'voice-short'), true);
  assert.equal(wakesThread({ status: 'completed', needsInput: true, depth: 0 }, 'voice-short'), true);
  assert.equal(wakesThread({ status: 'completed', needsInput: false, depth: 0 }, 'voice-short'), false);
  assert.equal(wakesThread({ status: 'completed', needsInput: false, depth: 0 }, 'text'), true);
});

test('depth grows by one per delivered update chain', () => {
  assert.equal(depthAfter([]), 0);
  assert.equal(depthAfter([{ depth: 0 }, { depth: 2 }]), 3);
});
