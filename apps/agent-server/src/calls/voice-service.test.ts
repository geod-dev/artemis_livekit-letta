import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger } from '@artemis/core';
import { FakeClock } from '@artemis/core/testing';
import type { ConversationService } from '../conversations/service.ts';
import type { TurnHandle, TurnOutcome } from '../turns/types.ts';
import { createCallSessions } from './call-sessions.ts';
import { createVoiceService } from './voice-service.ts';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

const messages = [{ role: 'user', content: 'hello there', id: 'item_1' }];

/** A voice service over real call sessions, with the turn handle the test controls. */
function setup(done: Promise<TurnOutcome>) {
  const clock = new FakeClock();
  const calls = createCallSessions(clock);
  const handle: TurnHandle = { turnId: 'turn_1', done };
  const conversations = {
    submitVoiceTurn: async () => handle,
    submitUpdateTurn: async () => handle,
  } as unknown as Pick<ConversationService, 'submitVoiceTurn' | 'submitUpdateTurn'>;
  const delivery = {
    claimQueued: async () => null,
    complete: async () => undefined,
    rollback: async () => undefined,
  };
  const voice = createVoiceService({ conversations, calls, delivery, logger });
  return { calls, voice };
}

test('voice admission is not released after a completed turn', async () => {
  const { calls, voice } = setup(Promise.resolve({ turnId: 'turn_1', status: 'completed', text: 'Hi' }));
  const completion = await voice.complete('c1', { messages, callId: 'call-1', signal: new AbortController().signal, onText: () => {} });

  assert.deepEqual(await completion.finished, { apology: false });
  assert.equal(calls.newVoiceInput('c1', 'call-1', messages), null, 'the completed utterance stays admitted');
});

test('handle.done rejection releases voice admissions', async () => {
  const { calls, voice } = setup(Promise.reject(new Error('scheduler closed')));
  const completion = await voice.complete('c1', { messages, callId: 'call-1', signal: new AbortController().signal, onText: () => {} });

  await assert.rejects(completion.finished, /scheduler closed/);
  assert.equal(calls.newVoiceInput('c1', 'call-1', messages)?.text, 'hello there', 'the failed utterance can be sent again');
});
