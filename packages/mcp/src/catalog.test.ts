import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { McpServer } from '@artemis/contracts/chat-types';
import { McpCatalog, qualifiedName, toCatalogTools } from './catalog.ts';
import { McpClient, type ListedTool } from './client.ts';
import { FakeMcpClient } from './test-support.ts';

const WEB: McpServer = { name: 'web', transport: 'http', url: 'https://web.example.com/mcp' };
const NOTES: McpServer = { name: 'notes', transport: 'sse', url: 'https://notes.example.com/sse' };
const LOCAL: McpServer = { name: 'local', transport: 'stdio', command: 'local-mcp' };

const CATALOG = {
  web: [
    { name: 'web_search', description: '  Search the web.  ', readOnly: true },
    { name: 'fetch_page', description: 'Read one web page.', readOnly: true },
  ],
  notes: [
    { name: 'search', description: 'Search notes.', readOnly: true },
    { name: 'create_note', description: 'Create a note.' },
  ],
  local: [{ name: 'ls', description: 'List files.', readOnly: true }],
};

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('qualified names and catalog entries', () => {
  test("names tools mcp__<server>__<tool> and reads the server's read-only hint", () => {
    const [tool] = toCatalogTools(WEB, [{ name: 'web_search', annotations: { readOnlyHint: true } }]);
    assert.equal(tool?.qualified, 'mcp__web__web_search');
    assert.equal(tool?.readOnly, true);
    assert.equal(toCatalogTools(WEB, [{ name: 'x' }])[0]?.readOnly, false);
  });

  test('server names become the namespace; anything else is slugged', () => {
    assert.equal(qualifiedName('my-server_1', 'go'), 'mcp__my-server_1__go');
    assert.equal(qualifiedName('a b.c', 'go'), 'mcp__a_b_c__go');
  });

  test('a listed tool without a usable name is skipped; a missing schema gets an empty object schema', () => {
    const listed: ListedTool[] = [{ name: '' }, { name: 'bare' }];
    assert.deepEqual(
      toCatalogTools(WEB, listed).map((tool) => [tool.tool, tool.inputSchema]),
      [['bare', { type: 'object', properties: {} }]]
    );
  });
});

describe('McpCatalog', () => {
  test('lists every configured server, stdio included (the agent-server spawns those itself)', async () => {
    const catalog = new McpCatalog(new FakeMcpClient(CATALOG), () => [WEB, NOTES, LOCAL]);
    const tools = await catalog.tools();
    assert.deepEqual(new Set(tools.map((tool) => tool.server.name)), new Set(['web', 'notes', 'local']));
    assert.equal(tools.find((tool) => tool.tool === 'web_search')?.description, 'Search the web.');
  });

  test('a server that fails is reported and keeps no tools; the others still list', async () => {
    const client = new FakeMcpClient(CATALOG);
    client.failing.add('notes');
    const catalog = new McpCatalog(client, () => [WEB, NOTES]);
    const tools = await catalog.tools();
    assert.equal(tools.length, 2);
    assert.deepEqual(catalog.status(), {
      servers: ['web'],
      tools: 2,
      failures: { notes: '401' },
      refreshedAt: catalog.status().refreshedAt,
    });
    assert.notEqual(catalog.status().refreshedAt, null);
  });

  test('tools are cached within the TTL and refreshed after it', async () => {
    const time = clock();
    const client = new FakeMcpClient(CATALOG);
    const catalog = new McpCatalog(client, () => [WEB], { ttlMs: 60_000, now: time.now });
    await catalog.tools();
    await catalog.tools();
    assert.equal(client.listed.length, 1);
    time.advance(60_001);
    await catalog.tools();
    assert.equal(client.listed.length, 2);
    await catalog.tools({ refresh: true });
    assert.equal(client.listed.length, 3);
  });

  test('concurrent refreshes share one listing run', async () => {
    const client = new FakeMcpClient(CATALOG);
    const catalog = new McpCatalog(client, () => [WEB, NOTES]);
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.tools()]);
    assert.deepEqual(client.listed.sort(), ['notes', 'web']);
  });

  test('servers are listed with bounded fan-out', async () => {
    let active = 0;
    let peak = 0;
    class SlowClient extends McpClient {
      async listTools(): Promise<ListedTool[]> {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [];
      }
      async callTool(): Promise<never> {
        throw new Error('not used');
      }
      async close(): Promise<void> {}
    }
    const servers = Array.from({ length: 8 }, (_, index) => ({ name: `s${index}`, command: 'x' }));
    await new McpCatalog(new SlowClient(), () => servers, { fanout: 3 }).refresh();
    assert.equal(peak, 3);
  });

  test('names are the sorted qualified names', async () => {
    const catalog = new McpCatalog(new FakeMcpClient(CATALOG), () => [WEB, NOTES]);
    assert.deepEqual(await catalog.names(), [
      'mcp__notes__create_note',
      'mcp__notes__search',
      'mcp__web__fetch_page',
      'mcp__web__web_search',
    ]);
  });
});
