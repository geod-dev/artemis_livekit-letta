import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordingEnd } from './voice-recording-end.ts';

const MAX = 25 * 1024 * 1024;

test('a normal recording is transcribed', () => {
  assert.equal(recordingEnd({ tooLarge: false, tooLong: false, size: 1200 }, MAX), 'transcribe');
  assert.equal(recordingEnd({ tooLarge: false, tooLong: false, size: MAX }, MAX), 'transcribe');
});

test('silence with no audio data is empty, not transcribed', () => {
  assert.equal(recordingEnd({ tooLarge: false, tooLong: false, size: 0 }, MAX), 'empty');
});

test('a recording over the size limit is too large, whatever its length', () => {
  assert.equal(recordingEnd({ tooLarge: false, tooLong: false, size: MAX + 1 }, MAX), 'too-large');
  assert.equal(recordingEnd({ tooLarge: true, tooLong: false, size: 10 }, MAX), 'too-large');
});

test('a recording cut at the time limit is too long, even when it is also large or empty', () => {
  assert.equal(recordingEnd({ tooLarge: false, tooLong: true, size: 10 }, MAX), 'too-long');
  assert.equal(recordingEnd({ tooLarge: false, tooLong: true, size: 0 }, MAX), 'too-long');
  assert.equal(recordingEnd({ tooLarge: true, tooLong: true, size: 10 }, MAX), 'too-large');
});
