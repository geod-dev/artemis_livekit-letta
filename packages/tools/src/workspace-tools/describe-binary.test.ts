import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeBinary } from './files.ts';

const bytes = (text: string, prefix: number[] = []) =>
  new Uint8Array([...prefix, ...Buffer.from(text, 'latin1')]);

test('describeBinary labels a binary file from its signature', () => {
  assert.equal(describeBinary(bytes('%PDF-1.7\n')), 'PDF document');
  assert.equal(
    describeBinary(bytes('\x03\x04\x00\x00', [0x50, 0x4b])),
    'zip archive (xlsx, docx, pptx, ...)'
  );
  assert.equal(describeBinary(bytes('RIFF\x00\x00\x00\x00WAVE')), 'WAV audio');
  assert.equal(describeBinary(bytes('OggS\x00')), 'Ogg audio');
  assert.equal(describeBinary(bytes('\x00\x00\x00\x18ftypmp42')), 'MPEG-4 media');
  assert.equal(describeBinary(new Uint8Array([0, 1, 2, 3])), 'binary data');
});
