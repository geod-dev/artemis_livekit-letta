import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatToolValue, readToolOutput, toolOutputText } from './tool-output.ts';

test('formats values defensively and handles unserializable values', () => {
  assert.equal(formatToolValue('plain'), 'plain');
  assert.equal(formatToolValue({ a: 1 }, 2), '{\n  "a": 1\n}');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(formatToolValue(circular), '[object Object]');
});

test('reads MCP text and artifact links without exposing artifact internals', () => {
  const output = readToolOutput(
    JSON.stringify({
      isError: false,
      structuredContent: { private: 'do not display' },
      content: [
        { type: 'text', text: 'The report is ready.' },
        {
          type: 'resource',
          resource: {
            uri: 'file:///secret/hidden.json',
            mimeType: 'application/json',
            artifact: { path: '/secret/path', name: 'report.json' },
            workspaceUrl: '/api/workspace/artifacts/abc',
          },
        },
        { type: 'image', data: 'base64-secret', mimeType: 'image/png' },
      ],
    })
  );

  assert.equal(output.isEnvelope, true);
  assert.equal(output.text, 'The report is ready.');
  assert.deepEqual(output.artifacts, [
    { name: 'report.json', url: '/api/workspace/artifacts/abc', kind: 'resource' },
  ]);
  assert.equal(JSON.stringify(output).includes('secret'), false);
});

test('strips managed-artifact control markers and preserves legacy plain output', () => {
  const marker = '[[mcp-managed-artifacts:v1:9beba3bc-eb78-47eb-95e1-c590a3927374]]';
  assert.equal(toolOutputText(`${marker}\n\nold result`), 'old result');
  assert.equal(readToolOutput(`${marker}\n\nold result`).text, 'old result');
});

test('recognizes the bridge attachment prefix before its serialized envelope', () => {
  const marker = '[[mcp-managed-artifacts:v1:9beba3bc-eb78-47eb-95e1-c590a3927374]]';
  const output = readToolOutput(
    `${marker}\n\n[MCP image](/api/workspace/image.png)\n\n${JSON.stringify(
      {
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            workspaceUrl: '/api/workspace/image.png',
            artifact: { name: 'image.png', path: '/private/image.png' },
          },
        ],
      },
      null,
      2
    )}`
  );
  assert.equal(output.isEnvelope, true);
  assert.equal(output.text, '');
  assert.deepEqual(output.artifacts, [
    { name: 'image.png', url: '/api/workspace/image.png', kind: 'image' },
  ]);
});
