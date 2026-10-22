import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConflictError } from '@artemis/core';
import type { McpServer } from '@artemis/contracts/chat-types';
import { type McpSettingsStore, McpServerRegistry } from './registry.ts';
import { mcpRevision } from './settings.ts';

const manual: McpServer = { name: 'search', transport: 'http', url: 'https://example.com/mcp' };
const device: McpServer = {
  name: 'device_laptop',
  transport: 'http',
  url: 'http://backend:3000/internal/mcp/devices/laptop',
  headers: { Authorization: 'Bearer internal-only' },
  managed: { type: 'device', deviceName: 'laptop', connectedAt: '2026-10-12T00:00:00Z', tools: 1 },
};

/** Storage fake with the same compare-and-set rule as the Postgres repository. */
class MemorySettingsStore implements McpSettingsStore {
  servers: McpServer[] = [];
  invalidEntries: unknown[] = [];
  revision: string | null = null;
  saves = 0;
  /** Runs after `load` returned, to simulate another writer slipping in. */
  afterLoad: (() => void) | null = null;

  async load() {
    const loaded = { servers: this.servers, invalidEntries: this.invalidEntries, revision: this.revision };
    this.afterLoad?.();
    return loaded;
  }

  async save(servers: McpServer[], invalidEntries: unknown[], expectedRevision: string | null): Promise<string> {
    if (expectedRevision !== this.revision) {
      throw new ConflictError('revision_conflict', 'MCP settings were changed by another save; reload and retry');
    }
    this.saves += 1;
    this.servers = structuredClone(servers);
    this.invalidEntries = invalidEntries;
    this.revision = mcpRevision(servers);
    return this.revision;
  }
}

async function registryWith(
  servers: McpServer[],
  onChange: (servers: McpServer[]) => Promise<void> = async () => {}
) {
  const store = new MemorySettingsStore();
  store.servers = servers;
  store.revision = mcpRevision(servers);
  const registry = new McpServerRegistry(store, onChange);
  await registry.load();
  return { store, registry };
}

function names(servers: McpServer[]): string[] {
  return servers.map((server) => server.name);
}

describe('managed and manual servers', () => {
  test('manual saves keep connected devices; disconnecting removes only the devices', async () => {
    const { registry, store } = await registryWith([manual]);
    await registry.setManaged([device]);
    await registry.save([{ ...manual, name: 'new_search' }], null);
    assert.deepEqual(names(registry.servers()), ['new_search', 'device_laptop']);
    assert.deepEqual(names(store.servers), ['new_search']);

    await registry.setManaged([]);
    assert.deepEqual(names(registry.servers()), ['new_search']);
  });

  test('a restart reads only the stored list; devices come back only when connected', async () => {
    const { registry } = await registryWith([manual]);
    assert.deepEqual(names(registry.servers()), ['search']);
    await registry.setManaged([device]);
    assert.deepEqual(names(registry.servers()), ['search', 'device_laptop']);
  });

  test('the editor cannot create managed entries or take a connected device name', async () => {
    const { registry, store } = await registryWith([manual]);
    await registry.setManaged([device]);
    await assert.rejects(registry.save([{ ...manual, name: 'device_laptop' }], null), /connected device/);
    await assert.rejects(registry.save([device], null), /cannot be edited/);
    await assert.rejects(registry.setManaged([{ ...manual, name: 'search' }]), /not connection-managed/);
    await assert.rejects(
      registry.setManaged([device, { ...device }]),
      /Duplicate server name: device_laptop/
    );
    assert.deepEqual(names(store.servers), ['search']);
  });
});

describe('revisions', () => {
  test('settings expose the revision of the stored list', async () => {
    const { registry } = await registryWith([manual]);
    const settings = await registry.settings();
    assert.equal(settings.revision, mcpRevision([manual]));
    assert.deepEqual(settings.servers, [manual]);
    assert.deepEqual(settings.bridge, { servers: [], tools: 0, failures: {} });
  });

  test('a save with the revision the editor loaded succeeds and moves the revision on', async () => {
    const { registry } = await registryWith([manual]);
    const loaded = (await registry.settings()).revision;
    const saved = await registry.save([{ ...manual, url: 'https://new.example/mcp' }], loaded);
    assert.notEqual(saved.revision, loaded);
    assert.equal(saved.revision, mcpRevision([{ ...manual, url: 'https://new.example/mcp' }]));
  });

  test('a stale full-list save is rejected with revision_conflict and changes nothing', async () => {
    const { registry, store } = await registryWith([manual]);
    const stale = (await registry.settings()).revision;
    await registry.save([{ ...manual, url: 'https://first.example/mcp' }], stale);
    await assert.rejects(registry.save([{ ...manual, name: 'renamed' }], stale), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.code, 'revision_conflict');
      return true;
    });
    assert.deepEqual(names(store.servers), ['search']);
    assert.equal(store.servers[0]?.url, 'https://first.example/mcp');
  });

  test('an unconditional save (no revision) overwrites the list', async () => {
    const { registry, store } = await registryWith([manual]);
    await registry.save([{ ...manual, name: 'other' }], null);
    assert.deepEqual(names(store.servers), ['other']);
  });

  test('a store-level conflict from another writer surfaces to the caller', async () => {
    const { registry, store } = await registryWith([manual]);
    store.afterLoad = () => {
      store.revision = 'moved-by-someone-else';
    };
    await assert.rejects(registry.save([], null), ConflictError);
    assert.deepEqual(names(store.servers), ['search']);
  });
});

describe('catalog sync and settings', () => {
  test('a failing catalog refresh is reported as a failed sync, not thrown', async () => {
    const seen: string[][] = [];
    const { registry } = await registryWith([manual], async (servers) => {
      seen.push(names(servers));
      throw new Error('catalog down');
    });
    const response = await registry.save([manual], null);
    assert.deepEqual(seen, [['search']]);
    assert.equal(response.sync?.catalog, 'failed');
    assert.equal(response.sync?.saved, true);
    assert.equal(response.sync?.retryableRevision, response.revision);
  });

  test('a successful save reports a synced catalog, and every change refreshes it', async () => {
    let refreshes = 0;
    const { registry } = await registryWith([manual], async () => {
      refreshes += 1;
    });
    const response = await registry.save([manual], null);
    assert.equal(response.sync?.catalog, 'synced');
    await registry.setManaged([device]);
    assert.equal(refreshes, 2);
  });

  test('invalid stored entries are shown as diagnostics and never made operational', async () => {
    const store = new MemorySettingsStore();
    store.invalidEntries = [{ name: 'broken' }];
    const registry = new McpServerRegistry(store, async () => {});
    await registry.load();
    const settings = await registry.settings();
    assert.deepEqual(names(settings.servers), []);
    assert.equal(settings.diagnostics[0]?.index, 0);
    assert.match(settings.diagnostics[0]?.diagnostic ?? '', /command/);
  });

  test('the bridge section mirrors the catalog status', async () => {
    const store = new MemorySettingsStore();
    const registry = new McpServerRegistry(store, async () => {}, () => ({
      servers: ['search'],
      tools: 3,
      failures: { notes: '401' },
      refreshedAt: null,
    }));
    await registry.load();
    assert.deepEqual((await registry.settings()).bridge, {
      servers: ['search'],
      tools: 3,
      failures: { notes: '401' },
    });
  });
});
