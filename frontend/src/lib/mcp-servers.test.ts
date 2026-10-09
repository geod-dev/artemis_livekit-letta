import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeServer, fromDraft, parsePairs, toDraft } from './mcp-servers.ts';

test('a remote server round-trips through the form, headers included', () => {
  const server = {
    name: 'search',
    transport: 'http' as const,
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer abc:def' },
  };
  assert.deepEqual(fromDraft(toDraft(server)), server);
});

test('a stdio server keeps its arguments and environment', () => {
  const server = {
    name: 'files',
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', 'server-files', '/workspace'],
    env: { TOKEN: 'a=b' },
  };
  assert.deepEqual(fromDraft(toDraft(server)), server);
});

test("switching transport drops the other transport's fields", () => {
  const draft = {
    ...toDraft({ name: 'x', command: 'cmd', args: ['a'] }),
    transport: 'sse' as const,
  };
  assert.deepEqual(fromDraft({ ...draft, url: ' https://e.com/sse ' }), {
    name: 'x',
    transport: 'sse',
    url: 'https://e.com/sse',
  });
});

test('pairs split at the first separator and skip lines without one', () => {
  assert.deepEqual(parsePairs('A: 1\n\nnot a pair\nB:2:3', ':'), { A: '1', B: '2:3' });
});

test('the list line shows where a server is, not its headers', () => {
  assert.equal(
    describeServer({ name: 's', transport: 'http', url: 'https://e.com/mcp', headers: { K: 'v' } }),
    'http · https://e.com/mcp'
  );
  assert.equal(describeServer({ name: 'l', command: 'uvx', args: ['tool'] }), 'stdio · uvx tool');
});
