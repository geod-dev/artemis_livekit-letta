import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Toolset } from '@artemis/tools';
import { TOOL_NAMES } from '@artemis/contracts/tool-names';
import type { AgentServerConfig } from '../config.ts';
import { EphemeralStorage } from '@artemis/storage/testing';
import type { Logger } from '@artemis/core';
import { FakeClock } from '@artemis/core/testing';
import { FakeMemoryStore } from '@artemis/memory/testing';
import { fact, seedConversation, seedTurn } from '../../test/memory-support.ts';
import { createMemoryCoordinator } from '../memory/coordinator.ts';
import type { AgentToolContext } from './index.ts';
import { createMemoryTools } from './memory-tools.ts';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

async function setup(enabled = true) {
  const store = new FakeMemoryStore();
  const clock = new FakeClock();
  const config: Pick<AgentServerConfig, 'assistant' | 'memory'> = {
    assistant: { name: 'Artemis', timezone: 'UTC', presentTool: false },
    memory: {
      enabled,
      hindsightUrl: 'http://hindsight:8888',
      bankId: 'artemis',
      retainEvery: 3,
      recallTimeoutMs: { voice: 1500, text: 4000 },
      recallMaxTokens: { low: 800, mid: 1500, high: 3000 },
    },
  };
  // The tools search through the coordinator, so the recall policy under test is the production one.
  const storage = new EphemeralStorage({ clock });
  await seedConversation(storage, 'c1');
  await seedTurn(storage, { id: 't1', conversationId: 'c1', text: 'What do I prefer?' });
  const coordinator = createMemoryCoordinator({ store, storage, config, clock, logger: silent });
  const toolset = new Toolset<AgentToolContext>(createMemoryTools({ store, coordinator, config, clock }));
  return { store, toolset };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('');
}

function context(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    conversationId: 'c1',
    taskId: null,
    turnId: 't1',
    toolCallId: 'call-1',
    signal: new AbortController().signal,
    mode: 'text',
    effort: null,
    ...overrides,
  } as AgentToolContext;
}

test('memory tools use the names of the toolset order', async () => {
  const { toolset } = await setup();
  assert.deepEqual(
    toolset.definitions().map((definition) => definition.name),
    [TOOL_NAMES.memorySearch, TOOL_NAMES.memoryRemember]
  );
});

test('memory_search renders the recalled facts with the default budget of the turn', async () => {
  const { store, toolset } = await setup();
  store.facts = [fact('f1', 'Lucas prefers metric units')];

  const result = await toolset.execute(TOOL_NAMES.memorySearch, { query: 'units' }, context({ mode: 'voice-short' }));

  assert.equal(result.isError, false);
  assert.match(textOf(result), /<recalled-memories>\n- \[world\] Lucas prefers metric units\n<\/recalled-memories>/);
  assert.equal(store.recalls[0]!.budget, 'low');
  assert.equal(store.recalls[0]!.maxTokens, 800);
});

test('memory_search honours an explicit budget and reports empty results without error', async () => {
  const { store, toolset } = await setup();
  const result = await toolset.execute(TOOL_NAMES.memorySearch, { query: 'nothing', budget: 'high' }, context({ effort: 'low' }));

  assert.equal(result.isError, false);
  assert.match(textOf(result), /No memories match/);
  assert.equal(store.recalls[0]!.budget, 'high');
  assert.equal(store.recalls[0]!.maxTokens, 3000);
});

test('memory_search turns store failures into an error result', async () => {
  const { store, toolset } = await setup();
  store.recall = async () => {
    throw new Error('hindsight down');
  };
  const result = await toolset.execute(TOOL_NAMES.memorySearch, { query: 'x' }, context());
  assert.equal(result.isError, true);
  assert.match(textOf(result), /hindsight down/);
});

test('memory_search rejects invalid input before reaching the store', async () => {
  const { store, toolset } = await setup();
  const result = await toolset.execute(TOOL_NAMES.memorySearch, { query: '', budget: 'huge' }, context());
  assert.equal(result.isError, true);
  assert.equal(store.recalls.length, 0);
});

test('memory_remember retains a tool note under its own document', async () => {
  const { store, toolset } = await setup();
  const result = await toolset.execute(
    TOOL_NAMES.memoryRemember,
    { content: 'Prefers morning meetings', context: 'said during planning' },
    context({ conversationId: 'c7' })
  );

  assert.equal(result.isError, false);
  assert.equal(store.retains.length, 1);
  const [request] = store.retains;
  assert.match(request!.documentId, /^memory-note:[0-9a-f-]{36}$/);
  assert.equal(request!.operationId, request!.documentId.slice('memory-note:'.length));
  assert.equal(request!.context, 'said during planning');
  assert.deepEqual(request!.metadata, { conversationId: 'c7', source: 'tool' });
  assert.equal(request!.turns[0]!.text, 'Prefers morning meetings');
});

test('memory_remember reports a failed retain and is refused when memory is disabled', async () => {
  const failing = await setup();
  failing.store.retainFailures = 1;
  const failed = await failing.toolset.execute(TOOL_NAMES.memoryRemember, { content: 'note' }, context());
  assert.equal(failed.isError, true);

  const disabled = await setup(false);
  const refused = await disabled.toolset.execute(TOOL_NAMES.memoryRemember, { content: 'note' }, context());
  assert.equal(refused.isError, true);
  assert.equal(disabled.store.retains.length, 0);
});
