import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolCall } from '../components/assistant-ui/tools/tool-display.ts';
import { selectToolRenderer, toolResultFormat } from './tool-renderer.ts';

test('file reads preserve source text while Markdown files retain formatting', () => {
  for (const path of ['/a.py', '/a.txt', '/a.json', '/Makefile']) {
    assert.equal(toolResultFormat(toolCall('Read', JSON.stringify({ file_path: path }))), 'text');
  }
  for (const path of ['/a.md', '/a.MD', '/a.markdown']) {
    assert.equal(toolResultFormat(toolCall('Read', JSON.stringify({ path }))), 'markdown');
  }
  assert.equal(toolResultFormat(toolCall('Read', '{}')), 'markdown');
});

test('web page fetches and searches keep Markdown, even with non-Markdown URL paths', () => {
  for (const tool of ['web_fetch_exa', 'web_search_exa']) {
    assert.equal(
      toolResultFormat(
        toolCall(
          'mcp_call',
          JSON.stringify({
            tool: `mcp__Exa__${tool}`,
            arguments: { path: 'https://example.test/page.txt' },
          })
        )
      ),
      'markdown'
    );
    assert.equal(toolResultFormat(toolCall(`mcp__Exa__${tool}`, '{}')), 'markdown');
  }
});

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
