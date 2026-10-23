import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatToolValue, readToolOutput } from './tool-output.ts';

test('formats values defensively and handles unserializable values', () => {
  assert.equal(formatToolValue('plain'), 'plain');
  assert.equal(formatToolValue({ a: 1 }, 2), '{\n  "a": 1\n}');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(formatToolValue(circular), '[object Object]');
});

test('plain text results are shown as they are', () => {
  assert.deepEqual(readToolOutput('The report is ready.'), {
    text: 'The report is ready.',
    artifacts: [],
  });
  assert.deepEqual(readToolOutput(undefined), { text: '', artifacts: [] });
});

test('a serialized MCP result shows the text of its content only', () => {
  const output = readToolOutput(
    JSON.stringify({
      isError: false,
      structuredContent: { private: 'do not display' },
      content: [
        { type: 'text', text: 'The report is ready.' },
        { type: 'image', data: 'base64-secret', mimeType: 'image/png' },
      ],
    })
  );
  assert.equal(output.text, 'The report is ready.');
  assert.equal(JSON.stringify(output).includes('secret'), false);
});

test('artifacts come from the call display, as workspace links', () => {
  const output = readToolOutput('Saved.', {
    type: 'mcp',
    qualified: 'mcp__media__render',
    artifacts: [
      { path: 'data/artifacts/conv/report.json', name: 'report.json', kind: 'file' },
      { path: 'data/artifacts/conv/image.png', name: 'image.png', kind: 'image' },
    ],
  });
  assert.deepEqual(output.artifacts, [
    {
      name: 'report.json',
      url: '/api/workspace/data/artifacts/conv/report.json',
      kind: 'file',
    },
    { name: 'image.png', url: '/api/workspace/data/artifacts/conv/image.png', kind: 'image' },
  ]);
  assert.deepEqual(readToolOutput('x', { type: 'present' }).artifacts, []);
});
