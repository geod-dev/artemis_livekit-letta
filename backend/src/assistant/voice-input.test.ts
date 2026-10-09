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

test('does not forward the same utterance twice (retries, interruptions)', () => {
  const first = [{ role: 'user', content: 'hello there' }];
  assert.equal(newVoiceInput('conv-b', first), 'hello there');
  assert.equal(newVoiceInput('conv-b', first), '');
  const next = [...first, { role: 'user', content: [{ type: 'text', text: 'and another thing' }] }];
  assert.equal(newVoiceInput('conv-b', next), 'and another thing');
});
