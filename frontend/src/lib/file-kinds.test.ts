import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileKind } from './file-kinds.ts';

test('names refine plain text types', () => {
  assert.equal(fileKind('text/plain', 'notes.md'), 'markdown');
  assert.equal(fileKind('text/plain', 'data.json'), 'json');
  assert.equal(fileKind('text/plain', 'main.py'), 'text');
  assert.equal(fileKind('text/plain', 'Makefile'), 'text');
});

test('specific types win over names', () => {
  assert.equal(fileKind('image/png', 'notes.md'), 'image');
  assert.equal(fileKind('text/plain', 'photo.png'), 'text');
  assert.equal(fileKind('text/markdown', 'README'), 'markdown');
});

test('names alone guess the kind until the type is known', () => {
  assert.equal(fileKind('', 'chart.PNG'), 'image');
  assert.equal(fileKind('', 'report.pdf'), 'pdf');
  assert.equal(fileKind('application/octet-stream', 'notes.markdown'), 'markdown');
  assert.equal(fileKind('', 'archive.zip'), 'other');
  assert.equal(fileKind('', '.md'), 'other');
});
