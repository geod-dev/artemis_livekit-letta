import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { syncMods } from '../internal-tools/install.ts';
import { renderToolsMod } from '../internal-tools/mod.ts';
import type { McpServer } from '../mcp/settings.ts';
import { McpCatalog, searchCatalog, toCatalogTools } from './catalog.ts';
import type { McpClientPort } from './client.ts';
import { BRIDGE_TOOL_SPECS, bridgeHandlers, resolveTool } from './tools.ts';

const WEB: McpServer = {
  name: 'web',
  transport: 'http',
  url: 'https://web.example.com/mcp',
};
const NOTES: McpServer = {
  name: 'notes',
  transport: 'sse',
  url: 'https://notes.example.com/sse',
};
const LOCAL: McpServer = {
  name: 'local',
  transport: 'stdio',
  command: 'local-mcp',
};

const LISTED: Record<string, { name: string; description: string; readOnly?: boolean }[]> = {
  web: [
    {
      name: 'web_search',
      description: 'Search the web for pages.',
      readOnly: true,
    },
    { name: 'fetch_page', description: 'Read one web page.', readOnly: true },
  ],
  notes: [
    { name: 'search', description: 'Search notes.', readOnly: true },
    { name: 'create_note', description: 'Create a note.' },
  ],
};

function fakeClient(calls: string[] = []): McpClientPort {
  return {
    listTools: async (server) =>
      (LISTED[server.name] ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        annotations: tool.readOnly ? { readOnlyHint: true } : {},
      })),
    callTool: async (server, tool, args) => {
      calls.push(`${server.name}.${tool} ${JSON.stringify(args)}`);
      return { text: `ran ${tool}`, isError: false };
    },
  };
}

function handlers(calls: string[] = []) {
  const client = fakeClient(calls);
  const catalog = new McpCatalog({
    servers: async () => [WEB, NOTES, LOCAL],
    client,
  });
  return bridgeHandlers(catalog, client);
}

describe('catalog', () => {
  test("names tools like Letta does and reads the server's read-only hint", () => {
    const [tool] = toCatalogTools(WEB, [
      { name: 'web_search', annotations: { readOnlyHint: true } },
    ]);
    assert.equal(tool?.qualified, 'mcp__web__web_search');
    assert.equal(tool?.readOnly, true);
    assert.equal(toCatalogTools(WEB, [{ name: 'x' }])[0]?.readOnly, false);
  });

  test('lists http and sse servers only: stdio stays on the skill wrapper', async () => {
    const catalog = new McpCatalog({
      servers: async () => [WEB, LOCAL],
      client: fakeClient(),
    });
    const tools = await catalog.refresh();
    assert.deepEqual(new Set(tools.map((tool) => tool.server.name)), new Set(['web']));
  });

  test('a server that fails is reported, the others still list', async () => {
    const client = fakeClient();
    const catalog = new McpCatalog({
      servers: async () => [WEB, NOTES],
      client: {
        ...client,
        listTools: async (server) => {
          if (server.name === 'notes') throw new Error('401');
          return client.listTools(server);
        },
      },
    });
    assert.equal((await catalog.refresh()).length, 2);
    assert.equal(catalog.snapshot().failures.get('notes'), '401');
  });

  test('search ranks name matches first', async () => {
    const catalog = new McpCatalog({
      servers: async () => [WEB, NOTES],
      client: fakeClient(),
    });
    const hits = searchCatalog(await catalog.refresh(), 'search the web');
    assert.equal(hits[0]?.qualified, 'mcp__web__web_search');
  });
});

describe('bridge tools', () => {
  test('a bare tool name resolves when only one server has it', async () => {
    const catalog = new McpCatalog({
      servers: async () => [WEB, NOTES],
      client: fakeClient(),
    });
    const tools = await catalog.refresh();
    assert.equal(
      (resolveTool(tools, 'fetch_page') as { qualified: string }).qualified,
      'mcp__web__fetch_page'
    );
    assert.equal(typeof resolveTool(tools, 'nope'), 'string');
  });

  test('mcp_call runs read-only tools and refuses the rest', async () => {
    const calls: string[] = [];
    const tools = handlers(calls);
    const read = await tools.get('mcp_call')!({
      tool: 'mcp__web__web_search',
      arguments: { query: 'x' },
    });
    assert.deepEqual(read, { text: 'ran web_search', isError: false });
    const write = await tools.get('mcp_call')!({
      tool: 'mcp__notes__create_note',
    });
    assert.equal(write.isError, true);
    assert.match(write.text, /mcp_call_write/);
    assert.deepEqual(calls, ['web.web_search {"query":"x"}']);
  });

  test('mcp_call_write runs a write, with JSON-string arguments too', async () => {
    const calls: string[] = [];
    const answer = await handlers(calls).get('mcp_call_write')!({
      tool: 'mcp__notes__create_note',
      arguments: '{"title":"a"}',
    });
    assert.equal(answer.isError, false);
    assert.deepEqual(calls, ['notes.create_note {"title":"a"}']);
  });

  test('up to 5 hits come described in full, so mcp_describe is not needed', async () => {
    const answer = await handlers().get('mcp_search')!({ query: 'note' });
    assert.match(answer.text, /mcp__notes__create_note \[writes: run with mcp_call_write\]/);
    assert.match(answer.text, /Parameters \(JSON schema\)/);
    assert.match(answer.text, /mcp_describe is not needed/);
  });

  test('more hits are listed one line each, marked read-only or writes', async () => {
    const many: McpServer = {
      name: 'many',
      transport: 'http',
      url: 'https://many.example.com',
    };
    const client: McpClientPort = {
      listTools: async () =>
        Array.from({ length: 6 }, (_, i) => ({
          name: `note_tool_${i}`,
          description: `Note tool ${i}.\nMore details.`,
        })),
      callTool: async () => ({ text: '', isError: false }),
    };
    const catalog = new McpCatalog({ servers: async () => [many], client });
    const answer = await bridgeHandlers(catalog, client).get('mcp_search')!({
      query: 'note',
    });
    assert.match(answer.text, /- mcp__many__note_tool_0: Note tool 0\. \[writes\]/);
    assert.doesNotMatch(answer.text, /More details|Parameters/);
    assert.match(answer.text, /Next: mcp_describe for parameters/);
  });
});

describe('bridge mod', () => {
  test('registers the four tools, calling the backend with the Letta token', () => {
    const source = renderToolsMod({
      title: 'mcp-bridge v1',
      tools: BRIDGE_TOOL_SPECS,
    });
    for (const spec of BRIDGE_TOOL_SPECS) assert.ok(source.includes(`"name": "${spec.name}"`));
    assert.ok(source.includes('/api/letta/tools/'));
    assert.ok(source.includes('process.env.LETTA_SERVER_TOKEN'));
  });

  test('with no tools the mod registers nothing', () => {
    const source = renderToolsMod({ title: 'mcp-bridge v1', tools: [] });
    assert.ok(source.includes('export default function activate() {}'));
    assert.ok(!source.includes('letta.tools.register'));
  });

  test('only a changed mod is written, and one reload covers it', async () => {
    const files = new Map<string, string>();
    let reloads = 0;
    const io = {
      read: async (path: string) => files.get(path) ?? null,
      write: async (path: string, content: string) => void files.set(path, content),
      reloadMods: async () => {
        reloads += 1;
        return true;
      },
    };
    const mods = [{ path: '/m.mjs', source: 'a' }];
    assert.equal(await syncMods(io, mods), 'reloaded');
    assert.equal(await syncMods(io, mods), 'unchanged');
    assert.equal(reloads, 1);
  });

  test('retries a failed reload even when the rendered file is unchanged', async () => {
    const files = new Map<string, string>();
    let reloads = 0;
    const io = {
      read: async (path: string) => files.get(path) ?? null,
      write: async (path: string, content: string) => void files.set(path, content),
      reloadMods: async () => ++reloads > 1,
    };
    const mods = [{ path: '/m.mjs', source: 'a' }];
    assert.equal(await syncMods(io, mods), 'reload-pending');
    assert.equal(await syncMods(io, mods), 'reloaded');
    assert.equal(reloads, 2);
  });
});
