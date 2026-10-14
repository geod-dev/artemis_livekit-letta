import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GLOBAL_MCP_AGENT,
  InvalidMcpServersError,
  LOCAL_BASE_URL,
  SettingsUnreadableError,
  readMcpServers,
  readMcpSettings,
  renderMcpSettings,
  validateMcpServers,
} from './settings.ts';

const SEARCH = {
  name: 'search',
  transport: 'http' as const,
  url: 'https://mcp.example.com/mcp',
};

describe('renderMcpSettings', () => {
  test("stores the list under the global agent, with the local backend's baseUrl", () => {
    // `letta mcp` matches agentId AND baseUrl; without the key the entry is invisible.
    const parsed = JSON.parse(renderMcpSettings([SEARCH]));
    assert.deepEqual(parsed.agents, [
      {
        agentId: GLOBAL_MCP_AGENT,
        baseUrl: LOCAL_BASE_URL,
        mcpServers: [SEARCH],
      },
    ]);
    assert.ok(GLOBAL_MCP_AGENT.startsWith('agent-local-'));
  });

  test('marks the one-time migration done, so the CLI never rewrites the file', () => {
    assert.equal(JSON.parse(renderMcpSettings([])).autoConversationTitlesRollbackApplied, true);
  });

  test('round-trips through readMcpServers', () => {
    assert.deepEqual(readMcpServers(renderMcpSettings([SEARCH])), [SEARCH]);
  });
});

describe('readMcpServers', () => {
  test('no agents, no global entry, or no servers read as empty', () => {
    assert.deepEqual(readMcpServers('{}'), []);
    assert.deepEqual(
      readMcpServers(JSON.stringify({ agents: [{ agentId: 'agent-local-x' }] })),
      []
    );
    assert.deepEqual(
      readMcpServers(JSON.stringify({ agents: [{ agentId: GLOBAL_MCP_AGENT }] })),
      []
    );
  });

  test("ignores other agents' entries", () => {
    const raw = JSON.stringify({
      agents: [
        {
          agentId: 'agent-local-x',
          mcpServers: [{ name: 'not-ours', command: 'x' }],
        },
        { agentId: GLOBAL_MCP_AGENT, mcpServers: [SEARCH] },
      ],
    });
    assert.deepEqual(readMcpServers(raw), [SEARCH]);
  });

  test('keeps malformed stored entries visible as diagnostics but out of operational lists', () => {
    const raw = JSON.stringify({
      agents: [
        {
          agentId: GLOBAL_MCP_AGENT,
          mcpServers: [{ name: 'odd' }, null, 'junk'],
        },
      ],
    });
    assert.deepEqual(readMcpServers(raw), []);
    assert.equal(readMcpSettings(raw).invalidEntries.length, 3);
    assert.match(readMcpSettings(raw).invalidEntries[0]?.diagnostic ?? '', /command/);
  });

  test('an unparseable file is an error, not an empty list that a save would overwrite', () => {
    assert.throws(() => readMcpServers('{not json'), SettingsUnreadableError);
    assert.throws(() => readMcpServers('[]'), SettingsUnreadableError);
  });
});

describe('validateMcpServers', () => {
  test('accepts the shapes the editor produces', () => {
    for (const server of [
      { name: 'a', transport: 'stdio', command: 'uvx', args: ['x'] },
      { name: 'b', transport: 'http', url: 'https://e.com/mcp' },
      {
        name: 'c',
        transport: 'sse',
        url: 'https://e.com/sse',
        headers: { A: '1' },
      },
      { name: 'd', command: 'bare' },
    ]) {
      assert.equal(validateMcpServers([server]).length, 1);
    }
  });

  test('refuses a nameless server, or a name that cannot be a tool namespace', () => {
    assert.throws(() => validateMcpServers([{ command: 'x' }]), InvalidMcpServersError);
    assert.throws(
      () => validateMcpServers([{ name: '   ', command: 'x' }]),
      InvalidMcpServersError
    );
    assert.throws(
      () => validateMcpServers([{ name: 'a b', command: 'x' }]),
      InvalidMcpServersError
    );
  });

  test('refuses an unknown transport', () => {
    assert.throws(
      () => validateMcpServers([{ name: 'a', transport: 'carrier-pigeon' }]),
      InvalidMcpServersError
    );
  });

  test('refuses a stdio server with no command and a remote server with no or a bad url', () => {
    assert.throws(
      () => validateMcpServers([{ name: 'a', transport: 'stdio' }]),
      InvalidMcpServersError
    );
    assert.throws(
      () => validateMcpServers([{ name: 'a', transport: 'http' }]),
      InvalidMcpServersError
    );
    assert.throws(
      () => validateMcpServers([{ name: 'a', transport: 'http', url: 'not a url' }]),
      InvalidMcpServersError
    );
  });

  test('refuses non-string args, env and headers', () => {
    assert.throws(
      () => validateMcpServers([{ name: 'a', command: 'x', args: [1] }]),
      InvalidMcpServersError
    );
    assert.throws(
      () => validateMcpServers([{ name: 'a', command: 'x', env: { K: 1 } }]),
      InvalidMcpServersError
    );
    assert.throws(
      () =>
        validateMcpServers([
          {
            name: 'a',
            transport: 'http',
            url: 'https://e.com',
            headers: { K: {} },
          },
        ]),
      InvalidMcpServersError
    );
  });

  test('refuses duplicate names and a non-array payload', () => {
    assert.throws(
      () =>
        validateMcpServers([
          { name: 'a', command: 'x' },
          { name: 'a', command: 'y' },
        ]),
      /Duplicate/
    );
    assert.throws(() => validateMcpServers({ name: 'a' }), InvalidMcpServersError);
    assert.throws(() => validateMcpServers(null), InvalidMcpServersError);
  });

  test('trims the name, defaults the transport and drops empty fields', () => {
    const [server] = validateMcpServers([
      { name: '  padded  ', command: ' x ', args: [], env: {}, headers: {} },
    ]);
    assert.deepEqual(server, {
      name: 'padded',
      transport: 'stdio',
      command: 'x',
    });
  });

  test('rejects wrong field shapes and unsafe remote schemes', () => {
    assert.throws(
      () => validateMcpServers([{ name: 'a', command: 'x', args: 'not-array' }]),
      /array/
    );
    assert.throws(
      () => validateMcpServers([{ name: 'a', transport: 'http', url: 'file:///tmp/x' }]),
      /invalid url/
    );
    assert.throws(
      () => validateMcpServers([{ name: 'a', command: 'x', unexpected: true }]),
      /unsupported field/
    );
  });

  test('preserves malformed disk entries when rendering a repaired valid list', () => {
    const parsed = JSON.parse(renderMcpSettings([SEARCH], [{ name: 'incomplete' }]));
    assert.deepEqual(parsed.agents[0].mcpServers, [{ name: 'incomplete' }, SEARCH]);
  });
});
