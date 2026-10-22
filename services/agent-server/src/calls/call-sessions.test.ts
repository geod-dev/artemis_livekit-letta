import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallControlEvent } from '@artemis/contracts/agent-server';
import { FakeClock } from '../memory/test-support.ts';
import { LocalCallSessions } from './call-sessions.ts';

function setup() {
  const clock = new FakeClock();
  return { clock, calls: new LocalCallSessions(clock) };
}

test('a dropped control channel ends the call after the reconnect grace period', () => {
  const { clock, calls } = setup();
  const ended: Array<[string, string[]]> = [];
  calls.onEnded((conversationId, pending) => ended.push([conversationId, pending]));

  const events: CallControlEvent[] = [];
  const close = calls.openChannel('c1', (event) => events.push(event), 'long');
  assert.deepEqual(calls.active('c1'), { mode: 'long', next: 'listen' });
  const callId = calls.callId('c1');

  calls.announceUpdate('c1', 'u1');
  close();
  clock.advance(9_999);
  assert.ok(calls.active('c1'), 'still active inside the grace period');

  clock.advance(1);
  assert.equal(calls.active('c1'), null);
  assert.deepEqual(ended, [['c1', ['u1']]]);

  // A reconnect inside the grace period keeps the call and its id.
  const other = setup();
  const closed = other.calls.openChannel('c2', () => undefined);
  const firstId = other.calls.callId('c2');
  closed();
  other.clock.advance(5_000);
  other.calls.openChannel('c2', () => undefined);
  other.clock.advance(60_000);
  assert.ok(other.calls.active('c2'), 'the reconnected channel keeps the call open');
  assert.equal(other.calls.callId('c2'), firstId);
  assert.ok(callId);
});

test('announced updates are sent again to a reconnecting agent until taken', () => {
  const { calls } = setup();
  const first: CallControlEvent[] = [];
  const close = calls.openChannel('c1', (event) => first.push(event));
  assert.equal(calls.announceUpdate('c1', 'u1'), true);
  assert.deepEqual(first, [{ type: 'update', id: 'u1' }]);
  close();

  const second: CallControlEvent[] = [];
  calls.openChannel('c1', (event) => second.push(event));
  assert.deepEqual(second, [{ type: 'update', id: 'u1' }]);

  assert.equal(calls.takeUpdate('c1', 'u1'), true);
  assert.equal(calls.takeUpdate('c1', 'u1'), false);
});

test('a response ends a short call only when it declared itself done; end_call always ends it', () => {
  const { calls } = setup();
  calls.openChannel('short', () => undefined, 'short');
  calls.openChannel('long', () => undefined, 'long');

  calls.beginResponse('short');
  calls.finishResponse('short', 'done');
  assert.equal(calls.active('short')!.next, 'end');

  calls.beginResponse('short');
  calls.finishResponse('short', 'listen');
  assert.equal(calls.active('short')!.next, 'listen');

  calls.beginResponse('long');
  calls.finishResponse('long', 'done');
  assert.equal(calls.active('long')!.next, 'listen');

  calls.beginResponse('long');
  assert.equal(calls.requestEnd('long'), true);
  calls.finishResponse('long', null);
  assert.equal(calls.active('long')!.next, 'end');

  // The end request belongs to one response: beginning another clears it.
  calls.beginResponse('long');
  calls.finishResponse('long', null);
  assert.equal(calls.active('long')!.next, 'listen');
  assert.equal(calls.requestEnd('missing'), false);
});

test('voice input takes the trailing user messages once per call and item id', () => {
  const { calls } = setup();
  const first = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello', id: 'm1' },
    { role: 'user', content: 'again', id: 'm2' },
  ];
  const utterance = calls.newVoiceInput('c1', 'call-1', first);
  assert.equal(utterance?.text, 'hello\nagain');
  assert.equal(utterance?.clientMessageId, 'm2');
  calls.acceptVoiceInput('c1', 'call-1', utterance!.identities);

  assert.equal(calls.newVoiceInput('c1', 'call-1', first), null, 'LiveKit re-sent the same items');
  assert.equal(calls.newVoiceInput('c1', 'call-2', first)?.text, 'hello\nagain', 'a new call is a new scope');

  const next = [...first, { role: 'assistant', content: 'hi there' }, { role: 'user', content: 'new one', id: 'm3' }];
  assert.equal(calls.newVoiceInput('c1', 'call-1', next)?.text, 'new one', 'the assistant message ends the run');
});

test('a rejected voice input can be sent again', () => {
  const { calls } = setup();
  const messages = [{ role: 'user', content: 'retry me', id: 'm9' }];
  const utterance = calls.newVoiceInput('c1', 'call-1', messages)!;
  calls.acceptVoiceInput('c1', 'call-1', utterance.identities);
  assert.equal(calls.newVoiceInput('c1', 'call-1', messages), null);
  calls.rejectVoiceInput('c1', 'call-1', utterance.identities);
  assert.equal(calls.newVoiceInput('c1', 'call-1', messages)?.text, 'retry me');
});
