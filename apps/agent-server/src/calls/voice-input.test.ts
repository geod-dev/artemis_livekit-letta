import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManualClock } from '../../test/workers-support.ts';
import { trailingUserEntries, VoiceInputLedger } from './voice-input.ts';

const MINUTE = 60_000;

test('the trailing user messages are the new utterance; system rows and earlier turns are skipped', () => {
  const entries = trailingUserEntries([
    { role: 'user', content: 'old question', id: 'item_1' },
    { role: 'assistant', content: 'old answer' },
    { role: 'system', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: 'first part' }], id: 'item_2' },
    { role: 'user', content: 'second part', clientMessageId: 'item_3' },
  ]);

  assert.deepEqual(entries, [
    { text: 'first part', identity: 'item_2' },
    { text: 'second part', identity: 'item_3' },
  ]);
});

test('the ledger admits a LiveKit item once per call and forgets it after its TTL', () => {
  const clock = new ManualClock();
  const ledger = new VoiceInputLedger(clock);

  assert.equal(ledger.accepted('conv_1', 'call_1', 'item_1'), false, 'unknown items are not accepted yet');
  ledger.remember('conv_1', 'call_1', 'item_1');
  assert.equal(ledger.accepted('conv_1', 'call_1', 'item_1'), true);
  assert.equal(ledger.accepted('conv_1', 'call_2', 'item_1'), false, 'a retry in another call is a new utterance');

  clock.advance(29 * MINUTE);
  assert.equal(ledger.accepted('conv_1', 'call_1', 'item_1'), true, 'still inside the TTL');

  clock.advance(2 * MINUTE);
  assert.equal(ledger.accepted('conv_1', 'call_1', 'item_1'), false, 'expired after 30 minutes');
});

test('forget releases an admission whose turn did not complete, and missing ids are never admitted', () => {
  const ledger = new VoiceInputLedger(new ManualClock());
  ledger.remember('conv_1', 'call_1', 'item_1');
  ledger.forget('conv_1', 'call_1', 'item_1');
  assert.equal(ledger.accepted('conv_1', 'call_1', 'item_1'), false);

  ledger.remember('conv_1', null, 'item_2');
  ledger.remember('conv_1', 'call_1', null);
  assert.equal(ledger.accepted('conv_1', null, 'item_2'), false);
  assert.equal(ledger.accepted('conv_1', 'call_1', null), false);
});
