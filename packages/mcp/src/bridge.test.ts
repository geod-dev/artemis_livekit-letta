import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { McpServer } from '@artemis/contracts/chat-types';
import type { ToolContext } from '@artemis/tools';
import { McpCatalog } from './catalog.ts';
import { createMcpBridgeTools } from './bridge.ts';
import { type McpCallResult } from './client.ts';
import { FakeMcpClient } from './test-support.ts';

const WEB: McpServer = { name: 'web', transport: 'http', url: 'https://web.example.com/mcp' };
const NOTES: McpServer = { name: 'notes', transport: 'sse', url: 'https://notes.example.com/sse' };

const CATALOG = {
  web: [
    { name: 'web_search', description: 'Search the web for pages.', readOnly: true },
    { name: 'fetch_page', description: 'Read one web page.', readOnly: true },
  ],
  notes: [
    { name: 'search', description: 'Search notes.', readOnly: true },
    { name: 'create_note', description: 'Create a note.' },
  ],
};

/** The bridge uses only `conversationId` and `signal` from the context. */
function context(conversationId = 'conv_1'): ToolContext {
  return {
    conversationId,
    signal: new AbortController().signal,
    taskId: null,
    turnId: null,
    toolCallId: 'call_1',
    policy: 'interactive',
    access: { readOnlyPrefixes: [] },
  } as unknown as ToolContext;
}

function setup(client = new FakeMcpClient(CATALOG)) {
  const catalog = new McpCatalog(client, () => [WEB, NOTES]);
  const tools = createMcpBridgeTools(catalog, client);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const run = (name: string, input: Record<string, unknown>) => {
    const tool = byName.get(name);
    assert.ok(tool, `missing tool ${name}`);
    return tool.execute(input, context());
  };
  return { client, tools, run };
}

describe('bridge tool specs', () => {
  test('three tools in the fixed order, with the read-only split', () => {
    const { tools } = setup();
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.readOnly]),
      [
        ['mcp_describe', true],
        ['mcp_call', true],
        ['mcp_call_write', false],
      ]
    );
  });

  test('every tool requires `tool` and rejects unknown fields', () => {
    const { tools } = setup();
    for (const tool of tools) {
      assert.deepEqual(tool.inputSchema.required, ['tool']);
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });
});

describe('mcp_describe', () => {
  test('shows the qualified name, access mode, description and parameter schema', async () => {
    const { run } = setup();
    const answer = await run('mcp_describe', { tool: 'mcp__web__web_search' });
    assert.equal(answer.isError, false);
    const text = (answer.content[0] as { text: string }).text;
    assert.match(text, /^mcp__web__web_search \[read-only: run with mcp_call\]/);
    assert.match(text, /Search the web for pages\./);
    assert.match(text, /"type": "object"/);
  });

  test('a missing or unknown tool is an error the model can read', async () => {
    const { run } = setup();
    assert.equal((await run('mcp_describe', {})).isError, true);
    const unknown = await run('mcp_describe', { tool: 'nope' });
    assert.equal(unknown.isError, true);
    assert.match((unknown.content[0] as { text: string }).text, /No MCP tool named "nope"/);
  });
});

describe('name resolution', () => {
  test('a bare tool name resolves when only one server has it, and is ambiguous otherwise', async () => {
    const client = new FakeMcpClient({
      web: [{ name: 'search', readOnly: true }],
      notes: [{ name: 'search', readOnly: true }],
    });
    const { run } = setup(client);
    const ambiguous = await run('mcp_call', { tool: 'search' });
    assert.equal(ambiguous.isError, true);
    assert.match((ambiguous.content[0] as { text: string }).text, /several servers/);
    const exact = await run('mcp_call', { tool: 'mcp__web__search' });
    assert.equal(exact.isError, false);
  });
});

describe('mcp_call and mcp_call_write', () => {
  test('mcp_call runs read-only tools and refuses the rest without calling the server', async () => {
    const { client, run } = setup();
    const read = await run('mcp_call', { tool: 'mcp__web__web_search', arguments: { query: 'x' } });
    assert.equal(read.isError, false);
    assert.equal((read.content[0] as { text: string }).text, 'ran web_search on web');

    const write = await run('mcp_call', { tool: 'mcp__notes__create_note' });
    assert.equal(write.isError, true);
    assert.match((write.content[0] as { text: string }).text, /mcp_call_write/);
    assert.deepEqual(client.calls, ['web.web_search {"query":"x"}']);
  });

  test('mcp_call_write runs a write, with JSON-string arguments too', async () => {
    const { client, run } = setup();
    const answer = await run('mcp_call_write', {
      tool: 'mcp__notes__create_note',
      arguments: '{"title":"a"}',
    });
    assert.equal(answer.isError, false);
    assert.deepEqual(client.calls, ['notes.create_note {"title":"a"}']);
  });

  test('malformed arguments are refused before the server is called', async () => {
    const { client, run } = setup();
    const answer = await run('mcp_call_write', { tool: 'mcp__notes__create_note', arguments: [1, 2] });
    assert.equal(answer.isError, true);
    assert.match((answer.content[0] as { text: string }).text, /must be an object/);
    assert.deepEqual(client.calls, []);
  });

  test('an unreachable server is an error result, not a throw', async () => {
    const client = new FakeMcpClient(CATALOG);
    client.unreachable.add('web');
    const { run } = setup(client);
    const answer = await run('mcp_call', { tool: 'mcp__web__web_search' });
    assert.equal(answer.isError, true);
    assert.match((answer.content[0] as { text: string }).text, /could not be reached: connection refused/);
  });

  test('results carry display.mcp with the saved artifacts, and small images go to the model inline', async () => {
    const artifact = {
      path: 'data/artifacts/conv_1/chart.png',
      name: 'chart.png',
      kind: 'image' as const,
      mimeType: 'image/png',
      size: 4,
    };
    const answer: McpCallResult = {
      text: 'Saved to data/artifacts/conv_1/chart.png',
      isError: false,
      images: [{ mediaType: 'image/png', data: 'YWJj' }],
      artifacts: [artifact],
    };
    const client = new FakeMcpClient(CATALOG, () => answer);
    const { run } = setup(client);
    const result = await run('mcp_call', { tool: 'mcp__web__web_search' });
    assert.deepEqual(result.content, [
      { type: 'text', text: 'Saved to data/artifacts/conv_1/chart.png' },
      { type: 'image', mediaType: 'image/png', data: 'YWJj' },
    ]);
    assert.deepEqual(result.display, {
      type: 'mcp',
      qualified: 'mcp__web__web_search',
      server: 'web',
      tool: 'web_search',
      artifacts: [artifact],
    });
  });

  test('a long result is cut for the model', async () => {
    const client = new FakeMcpClient(CATALOG, () => ({
      text: 'x'.repeat(40_000),
      isError: false,
      images: [],
      artifacts: [],
    }));
    const { run } = setup(client);
    const result = await run('mcp_call', { tool: 'mcp__web__web_search' });
    const text = (result.content[0] as { text: string }).text;
    assert.ok(text.length < 31_000);
    assert.match(text, /\[Cut at 30000 characters/);
  });

  test('an empty successful result says so instead of sending nothing', async () => {
    const client = new FakeMcpClient(CATALOG, () => ({ text: '', isError: false, images: [], artifacts: [] }));
    const { run } = setup(client);
    const result = await run('mcp_call', { tool: 'mcp__web__web_search' });
    assert.equal((result.content[0] as { text: string }).text, '(no output)');
  });
});
