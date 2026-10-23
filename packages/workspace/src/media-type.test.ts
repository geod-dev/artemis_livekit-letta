import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageType, inspectedMimeType, isTextContent, sniffMedia } from './media-type.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('file types come from inspected bytes, not names', () => {
  assert.equal(imageType(PNG), 'image/png');
  assert.equal(inspectedMimeType(PNG), 'image/png');
  assert.equal(inspectedMimeType(Buffer.from('%PDF-1.7\n')), 'application/pdf');
  assert.equal(inspectedMimeType(Buffer.from('{"a":1}')), 'application/json');
  assert.equal(inspectedMimeType(Buffer.from('plain words')), 'text/plain; charset=utf-8');
  assert.equal(inspectedMimeType(Buffer.from([0, 1, 2, 3])), 'application/octet-stream');
});

test('sniffMedia labels binary content and falls back to binary data', () => {
  assert.deepEqual(sniffMedia(Buffer.from('%PDF-1.7\n')), {
    mimeType: 'application/pdf',
    label: 'PDF document',
  });
  assert.deepEqual(sniffMedia(Buffer.from([0, 1, 2, 3])), {
    mimeType: 'application/octet-stream',
    label: 'binary data',
  });
  assert.equal(isTextContent(Buffer.from('plain words\n')), true);
  assert.equal(isTextContent(Buffer.from([0x41, 0x00])), false);
  assert.equal(isTextContent(Buffer.from([0x41, 0x01])), false);
});
