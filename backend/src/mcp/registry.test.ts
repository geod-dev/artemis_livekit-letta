import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpRegistry } from './registry';
import type { McpIo } from './service';
import {
  MCP_SETTINGS_PATH,
  type McpServer,
  renderMcpSettings,
  validateMcpServers,
} from './settings';

const manual: McpServer = { name: 'search', transport: 'http', url: 'https://example.com/mcp' };
const device: McpServer = {
  name: 'device_laptop',
  transport: 'http',
  url: 'http://backend:3000/internal/mcp/devices/laptop',
  headers: { Authorization: 'Bearer internal-only' },
  managed: { type: 'device', deviceName: 'laptop', connectedAt: '2026-10-12T00:00:00Z', tools: 1 },
};
function fixture(initial: McpServer[], devices: () => McpServer[]) {
  const files = new Map([[MCP_SETTINGS_PATH, renderMcpSettings(initial)]]);
  const io: McpIo = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => {
      files.set(path, content);
    },
    enableSkill: async () => {},
    disableSkill: async () => {},
  };
  return new McpRegistry(io, devices, async () => {});
}
test('manual saves preserve connection-managed servers; disconnect and restart remove only devices', async () => {
  let connected = [device];
  const registry = fixture([manual], () => connected);
  await Promise.all([
    registry.reconcile(),
    registry.saveManual([{ ...manual, name: 'new_search' }]),
  ]);
  assert.deepEqual(
    (await registry.list()).map((s) => s.name),
    ['new_search', 'device_laptop']
  );
  connected = [];
  await registry.reconcile();
  assert.deepEqual(
    (await registry.list()).map((s) => s.name),
    ['new_search']
  );
  const restarted = fixture([manual, device], () => []);
  await restarted.reconcile();
  assert.deepEqual(await restarted.list(), [manual]);
});
test('API cannot create managed entries or overwrite a connected device namespace', async () => {
  assert.throws(() => validateMcpServers([device]), /cannot be edited/);
  const registry = fixture([manual], () => [device]);
  await registry.reconcile();
  await assert.rejects(
    registry.saveManual([{ ...manual, name: 'device_laptop' }]),
    /connected device/
  );
  await assert.rejects(registry.saveManual([device]), /managed/);
  assert.deepEqual(
    (await registry.list()).map((s) => s.name),
    ['search', 'device_laptop']
  );
});
