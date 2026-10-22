import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  InvalidMcpServersError,
  describeInvalidEntry,
  mcpRevision,
  readMcpEntries,
  validateMcpServers,
} from './settings.ts';

const SEARCH = {
  name: 'search',
  transport: 'http' as const,
  url: 'https://mcp.example.com/mcp',
};

describe('validateMcpServers', () => {
  test('accepts the shapes the editor produces', () => {
    for (const server of [
      { name: 'a', transport: 'stdio', command: 'uvx', args: ['x'] },
      { name: 'b', transport: 'http', url: 'https://e.com/mcp' },
      { name: 'c', transport: 'sse', url: 'https://e.com/sse', headers: { A: '1' } },
      { name: 'd', command: 'bare' },
    ]) {
      assert.equal(validateMcpServers([server]).length, 1);
    }
  });

  test('refuses a nameless server, or a name that cannot be a tool namespace', () => {
    assert.throws(() => validateMcpServers([{ command: 'x' }]), InvalidMcpServersError);
    assert.throws(() => validateMcpServers([{ name: '   ', command: 'x' }]), InvalidMcpServersError);
    assert.throws(() => validateMcpServers([{ name: 'a b', command: 'x' }]), InvalidMcpServersError);
  });

  test('refuses an unknown transport', () => {
    assert.throws(
      () => validateMcpServers([{ name: 'a', transport: 'carrier-pigeon' }]),
      InvalidMcpServersError
    );
  });

  test('refuses a stdio server with no command and a remote server with no or a bad url', () => {
    assert.throws(() => validateMcpServers([{ name: 'a', transport: 'stdio' }]), InvalidMcpServersError);
    assert.throws(() => validateMcpServers([{ name: 'a', transport: 'http' }]), InvalidMcpServersError);
    assert.throws(
      () => validateMcpServers([{ name: 'a', transport: 'http', url: 'not a url' }]),
      InvalidMcpServersError
    );
  });

  test('refuses non-string args, env and headers', () => {
    assert.throws(() => validateMcpServers([{ name: 'a', command: 'x', args: [1] }]), InvalidMcpServersError);
    assert.throws(() => validateMcpServers([{ name: 'a', command: 'x', env: { K: 1 } }]), InvalidMcpServersError);
    assert.throws(
      () => validateMcpServers([{ name: 'a', transport: 'http', url: 'https://e.com', headers: { K: {} } }]),
      InvalidMcpServersError
    );
  });

  test('refuses duplicate names, a non-array payload, and more than 100 servers', () => {
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
    const many = Array.from({ length: 101 }, (_, index) => ({ name: `s${index}`, command: 'x' }));
    assert.throws(() => validateMcpServers(many), /At most 100/);
  });

  test('trims the name, defaults the transport and drops empty fields', () => {
    const [server] = validateMcpServers([
      { name: '  padded  ', command: ' x ', args: [], env: {}, headers: {} },
    ]);
    assert.deepEqual(server, { name: 'padded', transport: 'stdio', command: 'x' });
  });

  test('rejects wrong field shapes and unsafe remote schemes', () => {
    assert.throws(() => validateMcpServers([{ name: 'a', command: 'x', args: 'not-array' }]), /array/);
    assert.throws(
      () => validateMcpServers([{ name: 'a', transport: 'http', url: 'file:///tmp/x' }]),
      /invalid url/
    );
    assert.throws(
      () => validateMcpServers([{ name: 'a', command: 'x', unexpected: true }]),
      /unsupported field/
    );
  });

  test('connection-managed entries cannot be written through the editor', () => {
    assert.throws(
      () =>
        validateMcpServers([
          {
            name: 'device_laptop',
            transport: 'http',
            url: 'http://gateway/internal/mcp/devices/laptop',
            managed: { type: 'device', deviceName: 'laptop', connectedAt: '2026-10-12T00:00:00Z', tools: 1 },
          },
        ]),
      /cannot be edited/
    );
  });
});

describe('readMcpEntries', () => {
  test('valid entries stay operational', () => {
    assert.deepEqual(readMcpEntries([SEARCH]), { servers: [SEARCH], invalidEntries: [] });
  });

  test('malformed and duplicate entries are kept as diagnostics, not operational servers', () => {
    const { servers, invalidEntries } = readMcpEntries([
      { name: 'odd' },
      null,
      'junk',
      SEARCH,
      { ...SEARCH, url: 'https://other.example/mcp' },
    ]);
    assert.deepEqual(servers, [SEARCH]);
    assert.deepEqual(
      invalidEntries.map((entry) => entry.index),
      [0, 1, 2, 4]
    );
    assert.match(invalidEntries[0]?.diagnostic ?? '', /command/);
    assert.match(invalidEntries[3]?.diagnostic ?? '', /Duplicate server name: search/);
  });

  test('describeInvalidEntry explains why a stored entry is not operational', () => {
    assert.match(describeInvalidEntry({ name: 'broken' }), /command/);
  });
});

describe('mcpRevision', () => {
  test('is stable across key order and changes with the content', () => {
    const reordered = { url: SEARCH.url, transport: SEARCH.transport, name: SEARCH.name };
    assert.equal(mcpRevision([SEARCH]), mcpRevision([reordered]));
    assert.notEqual(mcpRevision([SEARCH]), mcpRevision([{ ...SEARCH, url: 'https://new.example/mcp' }]));
    assert.notEqual(mcpRevision([SEARCH]), mcpRevision([]));
    assert.match(mcpRevision([]), /^[0-9a-f]{64}$/);
  });
});
