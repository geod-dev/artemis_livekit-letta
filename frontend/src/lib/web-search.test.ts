import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWebSearchResult } from './web-search.ts';

const blocks = [
  'Title: Budget debate opens\nURL: https://www.france24.com/budget\nPublished: 2026-10-07T06:44:48.000Z\nAuthor: N/A\nHighlights:\nBudget debate opens\n\n# Budget debate opens\n\nThe Assembly opens the **budget** file.',
  'Title: Student movement\nURL: https://fr.wikipedia.org/wiki/Mouvement\nPublished: N/A\nAuthor: Lucie R.\nHighlights:\n| Type | Protest |\n| Pays | France |\nA movement against [austerity](https://x.dev).',
].join('\n\n---\n\n');

test('reads every result of a complete MCP result', () => {
  const output = parseWebSearchResult(
    JSON.stringify({ content: [{ type: 'text', text: blocks }] }, null, 2)
  );
  assert.equal(output?.truncated, false);
  assert.equal(output?.results.length, 2);
  assert.deepEqual(output?.results[0], {
    title: 'Budget debate opens',
    url: 'https://www.france24.com/budget',
    published: '2026-10-07T06:44:48.000Z',
    snippet: 'Budget debate opens The Assembly opens the budget file.',
  });
  assert.equal(output?.results[1].author, 'Lucie R.');
  assert.equal(output?.results[1].published, undefined);
  assert.equal(output?.results[1].snippet, 'A movement against austerity.');
});

test('reads result blocks as the MCP bridge returns them (plain text)', () => {
  assert.equal(parseWebSearchResult(blocks)?.results.length, 2);
});

test('reads the new MCP envelope with structured content and ignores binary artifacts', () => {
  const output = parseWebSearchResult(
    JSON.stringify({
      structuredContent: { count: 2 },
      content: [
        { type: 'image', data: 'not display text', mimeType: 'image/png' },
        { type: 'text', text: blocks },
      ],
    })
  );
  assert.equal(output?.results.length, 2);
});

test("notices the MCP bridge's cut", () => {
  const output = parseWebSearchResult(
    `${blocks}\n\n[Cut at 30000 characters: ask the tool for less, e.g. a smaller page.]`
  );
  assert.equal(output?.truncated, true);
  assert.equal(output?.results.length, 2);
});

test('returns null when there are no results to read', () => {
  assert.equal(parseWebSearchResult('Error: rate limited'), null);
  assert.equal(parseWebSearchResult(undefined), null);
});
