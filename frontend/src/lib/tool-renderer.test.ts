import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolDisplay } from '@shared/chat-types';
import { toolCall } from '../components/assistant-ui/tools/tool-display.ts';
import { selectToolRenderer, toolResultFormat } from './tool-renderer.ts';

const search = toolCall(
  'mcp_call',
  JSON.stringify({ tool: 'mcp__exa__web_search_exa', arguments: { query: 'news' } })
);
const shell = (display: Partial<Extract<ToolDisplay, { type: 'command' }>> = {}) =>
  toolCall('bash', JSON.stringify({ command: 'ls' }), {
    display: { type: 'command', command: 'ls', ...display },
  });

test('a web search shows its query while it runs and its results once done', () => {
  assert.deepEqual(selectToolRenderer(search, undefined, true), {
    kind: 'web-search',
    query: 'news',
    output: null,
  });
  const result = 'Title: News\nURL: https://news.example/a\nHighlights:\nA story.';
  const done = selectToolRenderer(search, result, false);
  assert.equal(done.kind, 'web-search');
  assert.equal(done.kind === 'web-search' && done.output?.results[0].url, 'https://news.example/a');
});

test('a command shows its output and exit status from its display', () => {
  assert.deepEqual(selectToolRenderer(shell(), undefined, true), {
    kind: 'terminal',
    command: 'ls',
    output: null,
  });
  assert.deepEqual(
    selectToolRenderer(
      shell({ exitCode: 0, stdout: 'a\nb\n', stderr: '', truncated: true }),
      'a\nb\n',
      false
    ),
    { kind: 'terminal', command: 'ls', output: { lines: ['a', 'b'], exitCode: 0, truncated: true } }
  );
  assert.deepEqual(
    selectToolRenderer(shell({ exitCode: 2, stderr: 'no such file' }), undefined, false),
    {
      kind: 'terminal',
      command: 'ls',
      output: { lines: ['no such file'], exitCode: 2, truncated: false },
    }
  );
});

test('a command without an exit code was killed by its timeout or a signal', () => {
  const timedOut = selectToolRenderer(shell({ timedOut: true }), undefined, false);
  assert.equal(timedOut.kind === 'terminal' && timedOut.output?.exitCode, 124);
  const signalled = selectToolRenderer(shell({ signal: 'SIGKILL' }), undefined, false);
  assert.equal(signalled.kind === 'terminal' && signalled.output?.exitCode, 137);
});

test('a command moved to the background keeps the generic display', () => {
  assert.equal(
    selectToolRenderer(
      shell({ background: { taskId: 'bash_1', reason: 'handoff' } }),
      'Command is still running',
      false
    ).kind,
    'generic'
  );
  assert.equal(selectToolRenderer(toolCall('read_file', '{}'), 'x', false).kind, 'generic');
});

test('only Markdown files read as Markdown, other reads as plain text', () => {
  assert.equal(toolResultFormat(toolCall('read_file', '{"path":"notes/a.md"}')), 'markdown');
  assert.equal(toolResultFormat(toolCall('read_file', '{"path":"data.json"}')), 'text');
  assert.equal(toolResultFormat(toolCall('read_file', '{}')), 'markdown');
  assert.equal(toolResultFormat(toolCall('bash', '{"command":"cat a.txt"}')), 'markdown');
});
