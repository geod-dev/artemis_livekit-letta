import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTitle, fallbackTitle } from './title-text.ts';

test('keeps a clean title as is', () => {
  assert.equal(cleanTitle('Python Ate My Homework'), 'Python Ate My Homework');
});

test('strips reasoning, labels, quotes, markdown and trailing punctuation', () => {
  assert.equal(
    cleanTitle('<think>The user wants a phone.</think>\n**Title: "Cheapskates Go Shopping!"**'),
    'Cheapskates Go Shopping'
  );
  assert.equal(cleanTitle('« Le Grand Départ du Bureau »'), 'Le Grand Départ du Bureau');
});

test('keeps only the first line and caps the length', () => {
  assert.equal(cleanTitle('Short Title\nBecause reasons'), 'Short Title');
  const long = cleanTitle('word '.repeat(30));
  assert.ok(long.length <= 60 && long.endsWith('…'));
});

test('rejects an empty reply', () => {
  assert.throws(() => cleanTitle('<think>hmm</think>\n  '));
});

test('falls back to the shortened first message', () => {
  assert.equal(fallbackTitle('  hello\n  there  '), 'hello there');
  assert.equal(fallbackTitle('   '), 'New chat');
});
