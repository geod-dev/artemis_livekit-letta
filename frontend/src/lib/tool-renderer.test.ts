import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolCall } from '../components/assistant-ui/tools/tool-display.ts';
import { selectToolRenderer } from './tool-renderer.ts';

const search = toolCall(
  'mcp_call',
  JSON.stringify({
    tool: 'mcp__Exa__web_search_exa',
    arguments: { query: 'news' },
  })
);
const shell = toolCall('Bash', JSON.stringify({ command: 'ls -la' }));

test('shows supported search and shell calls while they run', () => {
  assert.deepEqual(selectToolRenderer(search, undefined, true), {
    kind: 'web-search',
    query: 'news',
    output: null,
  });
  assert.deepEqual(selectToolRenderer(shell, undefined, true), {
    kind: 'terminal',
    command: 'ls -la',
    output: null,
  });
});

test('uses specialized renderers for readable results and generic fallback for unsupported receipts', () => {
  assert.equal(
    selectToolRenderer(
      search,
      JSON.stringify({ content: [{ type: 'text', text: 'Error: limited' }] }),
      false
    ).kind,
    'generic'
  );
  assert.equal(
    selectToolRenderer(shell, 'Command running in background with ID: b1', false).kind,
    'generic'
  );
  assert.deepEqual(selectToolRenderer(shell, 'Exit code: 3\nfailed', false, true), {
    kind: 'terminal',
    command: 'ls -la',
    output: { lines: ['failed'], exitCode: 3, truncated: false },
  });
});

test('recognizes legacy MCP search calls decoded from Bash', () => {
  const legacy = toolCall(
    'Bash',
    JSON.stringify({
      command: `letta mcp call mcp__exa__web_search_exa --args '{"query":"legacy"}'`,
    })
  );
  assert.equal(selectToolRenderer(legacy, 'Error: rate limited', false).kind, 'generic');
  assert.deepEqual(
    selectToolRenderer(
      legacy,
      'Title: T\nURL: https://example.test\nHighlights:\nA snippet.',
      false
    ),
    {
      kind: 'web-search',
      query: 'legacy',
      output: {
        results: [{ title: 'T', url: 'https://example.test', snippet: 'A snippet.' }],
        truncated: false,
      },
    }
  );
});
