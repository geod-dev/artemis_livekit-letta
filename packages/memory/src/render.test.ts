import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTranscript, renderRecalledMemories } from './render.ts';

test('formatTranscript writes one Speaker (time): text line per turn', () => {
  const text = formatTranscript([
    { speaker: 'User', at: '2026-10-22T09:00:00Z', text: '  Hello  ' },
    { speaker: 'Background task', at: '2026-10-22T09:00:05Z', text: 'Report ready' },
  ]);
  assert.equal(
    text,
    'User (2026-10-22T09:00:00Z): Hello\nBackground task (2026-10-22T09:00:05Z): Report ready',
  );
});

test('formatTranscript of no turns is empty', () => {
  assert.equal(formatTranscript([]), '');
});

test('renderRecalledMemories returns empty string when there are no facts', () => {
  assert.equal(renderRecalledMemories([]), '');
});

test('renderRecalledMemories renders typed facts with the best available date', () => {
  const block = renderRecalledMemories([
    { id: '1', text: 'User prefers meetings after 10am.', type: 'observation', mentionedAt: '2026-10-01T08:00:00Z' },
    { id: '2', text: "User's daughter is named Lea.", type: 'world', occurredAt: '2026-09-12T00:00:00Z', mentionedAt: '2026-10-01T08:00:00Z' },
    { id: '3', text: 'Assistant summarised the report.', type: 'experience' },
  ]);
  assert.equal(
    block,
    [
      '<recalled-memories>',
      '- [observation] User prefers meetings after 10am. (mentioned 2026-10-01)',
      "- [world] User's daughter is named Lea. (occurred 2026-09-12)",
      '- [experience] Assistant summarised the report.',
      '</recalled-memories>',
    ].join('\n'),
  );
});
