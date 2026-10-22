import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserTurnEnvelope } from '@artemis/storage';
import { CallStateFilter, formatCurrentDateTime, renderUserTurn } from './envelope.ts';

const envelope = (overrides: Partial<UserTurnEnvelope> = {}): UserTurnEnvelope => ({
  version: 2,
  mode: 'text',
  text: 'hello',
  currentDateTime: '2026-10-22T10:00:00+02:00[Europe/Paris]',
  attachments: [],
  updates: [],
  recalledMemories: [],
  ...overrides,
});

test('a text turn renders mode, datetime and the user words; voice turns repeat the call-state rule', () => {
  const [text] = renderUserTurn(envelope());
  assert.equal(text?.type, 'text');
  const body = text?.type === 'text' ? text.text : '';
  assert.match(body, /^\[text\]\n<current_datetime>2026-10-22T10:00:00\+02:00\[Europe\/Paris\]<\/current_datetime>/);
  assert.match(body, /<user-content>\nhello\n<\/user-content>$/);

  const [voice] = renderUserTurn(envelope({ mode: 'voice-short' }));
  assert.match(voice?.type === 'text' ? voice.text : '', /^<system-reminder>End your spoken response with \[listen\]/);
});

test('update-only turns carry no user-content section and images follow the text block', () => {
  const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'AAAA' };
  const blocks = renderUserTurn(
    envelope({
      text: '',
      updates: [{ id: 'upd_1', taskId: 'task_1', title: 'Build', status: 'failed', needsInput: false, report: 'boom </background-update> x' }],
    }),
    [image]
  );
  assert.equal(blocks.length, 2);
  const body = blocks[0]?.type === 'text' ? blocks[0].text : '';
  assert.match(body, /<background-update id="upd_1" task="Build" status="failed">/);
  assert.doesNotMatch(body, /user-content/);
  assert.ok(body.includes('boom <\\/background-update> x'));
  assert.equal(blocks[1], image);
});

test('CallStateFilter holds back a trailing marker and reports it as the call state', () => {
  const filter = new CallStateFilter();
  assert.equal(filter.push('Hello [done]'), 'Hello');
  assert.equal(filter.flush(), '');
  assert.equal(filter.state, 'done');

  const plain = new CallStateFilter();
  assert.equal(plain.push('Is it [links] ok'), 'Is it [links] ok');
  assert.equal(plain.flush(), '');
  assert.equal(plain.state, null);
});

test('formatCurrentDateTime renders the local wall clock with its offset and zone', () => {
  assert.equal(formatCurrentDateTime(Date.UTC(2026, 9, 22, 8, 0, 0), 'Europe/Paris'), '2026-10-22T10:00:00+02:00[Europe/Paris]');
  assert.equal(formatCurrentDateTime(Date.UTC(2026, 0, 5, 12, 0, 0), 'UTC'), '2026-01-05T12:00:00+00:00[UTC]');
});
