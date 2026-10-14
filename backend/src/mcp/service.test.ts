import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type McpIo, loadMcpServers, saveMcpServers } from './service.ts';
import { MCP_SETTINGS_PATH, type McpServer, renderMcpSettings } from './settings.ts';
import { MCP_SKILL_DIR, MCP_SKILL_NAME, renderMcpSkill } from './skill.ts';

const SEARCH: McpServer = {
  name: 'search',
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
};

/**
 * The same line-based parse Letta's frontmatter reader does: each unindented
 * line is `key: value`, split at the first colon, value verbatim. Later keys
 * win, which is exactly how an injected line would take over.
 */
function frontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const fields: Record<string, string> = {};
  for (const line of (match?.[1] ?? '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0 && line === line.trimStart()) {
      fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return fields;
}

function memoryIo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const events: string[] = [];
  const io: McpIo = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => {
      events.push(`write ${path}`);
      files.set(path, content);
    },
    enableSkill: async (path) => {
      events.push(`enable ${path}`);
    },
    disableSkill: async (name) => {
      events.push(`disable ${name}`);
    },
  };
  return { io, files, events };
}

describe('service paths used by the registry', () => {
  test('a fresh volume loads empty and save initializes settings plus no skill', async () => {
    const { io, files, events } = memoryIo();
    assert.deepEqual(await loadMcpServers(io), []);
    await saveMcpServers(io, []);
    assert.ok(files.has(MCP_SETTINGS_PATH));
    assert.equal(events.at(-1), `disable ${MCP_SKILL_NAME}`);
  });

  test('a configured server gets the skill, linked after its files exist', async () => {
    const { io, files, events } = memoryIo({
      [MCP_SETTINGS_PATH]: renderMcpSettings([SEARCH]),
    });
    assert.deepEqual(await loadMcpServers(io), [SEARCH]);
    await saveMcpServers(io, [SEARCH]);
    assert.ok(files.has(`${MCP_SKILL_DIR}/SKILL.md`));
    assert.ok(files.has(`${MCP_SKILL_DIR}/scripts/mcp.sh`));
    // Linked only after its files exist: skill_enable validates SKILL.md.
    assert.equal(events.at(-1), `enable ${MCP_SKILL_DIR}`);
  });

  test('an existing list is left as written and its skill re-rendered', async () => {
    const other: McpServer = { name: 'notes', command: 'notes-mcp' };
    const settings = renderMcpSettings([other]);
    const { io, files } = memoryIo({ [MCP_SETTINGS_PATH]: settings });
    assert.deepEqual(await loadMcpServers(io), [{ ...other, transport: 'stdio' }]);
    await saveMcpServers(io, [other]);
    assert.equal(files.get(MCP_SETTINGS_PATH), settings);
    assert.match(files.get(`${MCP_SKILL_DIR}/SKILL.md`) ?? '', /notes/);
  });
});

describe('saveMcpServers', () => {
  test('an empty list unlinks the skill instead of advertising nothing', async () => {
    const { io, events } = memoryIo();
    await saveMcpServers(io, []);
    assert.deepEqual(events, [`write ${MCP_SETTINGS_PATH}`, `disable ${MCP_SKILL_NAME}`]);
  });

  test('keeps malformed disk entries while saving valid servers', async () => {
    const malformed = { name: 'broken' };
    const { io, files } = memoryIo({
      [MCP_SETTINGS_PATH]: JSON.stringify({
        agents: [{ agentId: 'agent-local-mcp-global', mcpServers: [malformed] }],
      }),
    });
    await saveMcpServers(io, [SEARCH]);
    const saved = JSON.parse(files.get(MCP_SETTINGS_PATH) ?? '{}');
    assert.deepEqual(saved.agents[0].mcpServers, [malformed, SEARCH]);
  });

  test('reports skill sync failure after the settings have already been saved', async () => {
    const { io, files } = memoryIo();
    io.enableSkill = async () => {
      throw new Error('skill link failed');
    };
    const result = await saveMcpServers(io, [SEARCH]);
    assert.deepEqual(result, { skill: 'failed', error: 'skill link failed' });
    assert.deepEqual(JSON.parse(files.get(MCP_SETTINGS_PATH) ?? '{}').agents[0].mcpServers, [SEARCH]);
  });
});

describe('renderMcpSkill', () => {
  const [skill, wrapper] = renderMcpSkill([SEARCH, { name: 'notes', command: 'x' }]);

  test('frontmatter name matches the directory, and the description names every server', () => {
    assert.equal(skill?.path, `${MCP_SKILL_NAME}/SKILL.md`);
    const fields = frontmatter(skill?.content ?? '');
    assert.equal(fields.name, MCP_SKILL_NAME);
    assert.match(fields.description ?? '', /search, notes/);
  });

  // An agent that never loads the skill still sees its description, so that
  // line alone has to get it past Letta's empty-list "None" reminder.
  test('the description names both traps and sends agents to the native tools', () => {
    const description = frontmatter(skill?.content ?? '').description ?? '';
    assert.ok(description.includes('MCP servers with available tools: None'));
    assert.ok(description.includes('plain `letta mcp`'));
    assert.ok(description.includes('mcp_search / mcp_call'));
    assert.ok(skill?.content.includes('`mcp_call_write`'));
  });

  test('a line break in a server name cannot break the frontmatter', () => {
    const [odd] = renderMcpSkill([{ name: 'a\nname: evil', command: 'x' }]);
    assert.equal(frontmatter(odd?.content ?? '').name, MCP_SKILL_NAME);
  });

  test('the wrapper points letta mcp at the shared list', () => {
    assert.equal(wrapper?.path, `${MCP_SKILL_NAME}/scripts/mcp.sh`);
    assert.ok(
      wrapper?.content.includes(
        'HOME=/root/.letta/mcp-home exec letta mcp "$@" --agent agent-local-mcp-global'
      )
    );
  });
});
