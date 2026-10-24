import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnsi } from './ansi.ts';

const plain = (text: string) => ({ text, color: undefined, bold: false, dim: false });

test('plain text is one unstyled segment', () => {
  assert.deepEqual(parseAnsi('ready'), [plain('ready')]);
});

test('a colour applies until a reset', () => {
  assert.deepEqual(parseAnsi('\u001b[31mred\u001b[0m plain'), [
    { text: 'red', color: 31, bold: false, dim: false },
    plain(' plain'),
  ]);
});

test('bold and dim toggle independently, and 22 clears both', () => {
  assert.deepEqual(parseAnsi('\u001b[1;2mx\u001b[22my'), [
    { text: 'x', color: undefined, bold: true, dim: true },
    plain('y'),
  ]);
});

test('extended colours are skipped without changing the colour', () => {
  assert.deepEqual(parseAnsi('\u001b[38;5;200mz'), [plain('z')]);
});

test('segments with the same style are merged', () => {
  assert.deepEqual(parseAnsi('a\u001b[0mb'), [plain('ab')]);
});

test('OSC sequences are dropped up to their BEL terminator', () => {
  assert.deepEqual(parseAnsi('\u001b]0;title\u0007ok'), [plain('ok')]);
});

test('an unterminated control sequence drops its tail', () => {
  assert.deepEqual(parseAnsi('a\u001b[31'), [plain('a')]);
});
