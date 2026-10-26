import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger } from '@artemis/core';
import { FakeClock } from '@artemis/core/testing';
import type { McpCatalog } from '@artemis/mcp';
import type { ConversationRecord } from '@artemis/storage';
import { MCP_CATALOG_WAIT_MS, McpReminder } from './mcp-reminder.ts';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

const conversation = { mcpToolNamesShown: [] } as unknown as ConversationRecord;

function reminderWith(names: () => Promise<string[]>, clock: FakeClock): McpReminder {
  return new McpReminder({
    storage: { conversations: { setMcpToolNamesShown: async () => undefined } } as never,
    catalog: { names } as unknown as McpCatalog,
    clock,
    logger: silent,
  });
}

test('mcp reminder falls back when the catalog refresh exceeds the bound', async () => {
  const clock = new FakeClock();
  // A refresh that never settles, as with a hung MCP server.
  const reminder = reminderWith(() => new Promise<string[]>(() => {}), clock);

  const planned = reminder.plan('conv_hung', conversation, new AbortController().signal);
  clock.advance(MCP_CATALOG_WAIT_MS);
  const result = await Promise.race([planned, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1000))]);

  assert.notEqual(result, 'hung', 'the turn must not wait on a catalog refresh past its bound');
  assert.deepEqual(result, {});
});

test('a catalog answer inside the bound keeps the reminder and the planned names', async () => {
  const clock = new FakeClock();
  const reminder = reminderWith(async () => ['mcp__docs__search'], clock);

  const plan = await reminder.plan('conv_ok', conversation, new AbortController().signal);

  assert.deepEqual(plan.names, ['mcp__docs__search']);
  assert.match(plan.reminder ?? '', /mcp__docs__search/);
});
