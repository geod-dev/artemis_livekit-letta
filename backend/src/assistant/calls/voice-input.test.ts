import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newVoiceInput } from './voice-input.ts';

test('forwards only trailing user messages, ignoring system prompts and history', () => {
  const messages = [
    { role: 'system', content: 'instructions' },
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new question' },
  ];
  assert.equal(newVoiceInput('conv-a', messages), 'new question');
});

test('repeated speech remains valid input across requests and calls', async () => {
  const first = [{ role: 'user', id: 'utterance-1', content: 'hello there' }];
  assert.equal(newVoiceInput('conv-b', first, 'call-b'), 'hello there');
  const { rememberVoiceInput } = await import('./voice-input.ts');
  rememberVoiceInput('conv-b', 'call-b', 'utterance-1');
  assert.equal(newVoiceInput('conv-b', first, 'call-b'), '');
  const next = [...first, { role: 'user', content: [{ type: 'text', text: 'and another thing' }] }];
  assert.equal(newVoiceInput('conv-b', next, 'call-b'), 'and another thing');
  const repeatedWords = [...first, { role: 'user', id: 'utterance-2', content: 'hello there' }];
  assert.equal(newVoiceInput('conv-b', repeatedWords, 'call-b'), 'hello there');
});

test('deduplicates only accepted stable IDs scoped to the call', async () => {
  const { forgetVoiceInput, rememberVoiceInput, voiceInputAlreadyAccepted, voiceInputMessageId } = await import('./voice-input.ts');
  const messages = [{ role: 'user', id: 'speech-1', content: 'hello' }];
  const id = voiceInputMessageId(messages);
  assert.equal(id, 'speech-1');
  assert.equal(voiceInputAlreadyAccepted('conv-dedupe', 'call-1', id), false);
  rememberVoiceInput('conv-dedupe', 'call-1', id);
  assert.equal(voiceInputAlreadyAccepted('conv-dedupe', 'call-1', id), true);
  assert.equal(voiceInputAlreadyAccepted('conv-dedupe', 'call-2', id), false);
  assert.equal(voiceInputAlreadyAccepted('conv-dedupe', null, id), false);
  forgetVoiceInput('conv-dedupe', 'call-1', id!);
  assert.equal(voiceInputAlreadyAccepted('conv-dedupe', 'call-1', id), false);
});
