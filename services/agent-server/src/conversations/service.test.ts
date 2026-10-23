import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type LlmRequest, LlmProvider, type LlmStreamEvent, type ModelInfo, ProviderRegistry, type ToolDefinition } from '@artemis/llm';
import { NotFoundError } from '@artemis/core';
import { InMemoryStorage } from '@artemis/storage';
import { loadConfig } from '../config.ts';
import { ConversationEventHub } from '../events/hub.ts';
import { createModelRouter } from '../models/routing.ts';
import { PromptRenderer } from '../prompts/renderer.ts';
import { createConversationService } from './service.ts';

class StubProvider extends LlmProvider {
  readonly id: string = 'anthropic';

  async *stream(_request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    throw new Error('not used');
  }

  modelInfo(model: string): ModelInfo {
    return { model, contextWindow: 200_000, maxOutputTokens: 64_000, supportsThinking: true, supportsImages: true };
  }
}

class OtherStubProvider extends StubProvider {
  override readonly id: string = 'openai-compatible';
}

const TOOLS: ToolDefinition[] = [{ name: 'bash', description: 'Run a command', inputSchema: { type: 'object' } }];
const TEMPLATE = 'You are {{name}} in {{workspace}}, conversation {{conversation_id}}, time zone {{timezone}}.';

let dir: string;
let storage: InMemoryStorage;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'conv-prompts-'));
  await writeFile(join(dir, 'system.md'), TEMPLATE);
  await writeFile(join(dir, 'worker-rules.md'), 'rules');
  await writeFile(join(dir, 'title.md'), 'title');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function service(events = new ConversationEventHub()) {
  storage = new InMemoryStorage();
  const config = loadConfig({
    DATABASE_URL: 'postgresql://x',
    ASSISTANT_NAME: 'Artemis',
    ASSISTANT_TIMEZONE: 'Europe/Paris',
    WORKSPACE_PATH: '/workspace',
  });
  const router = createModelRouter(config, new ProviderRegistry([new StubProvider(), new OtherStubProvider()]));
  return {
    events,
    conversations: createConversationService({
      storage,
      prompts: new PromptRenderer(dir),
      router,
      events,
      config,
      toolDefinitions: () => TOOLS,
    }),
  };
}

describe('ConversationService', () => {
  it('renders and freezes the system prompt and tools at creation', async () => {
    const { conversations } = service();
    const created = await conversations.create({});
    assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(created.title, 'New chat');

    const snapshot = await storage.promptSnapshots.getForOwner('conversation', created.id);
    assert.equal(snapshot?.templateId, 'system');
    assert.equal(
      snapshot?.systemPrompt,
      `You are Artemis in ${resolve('/workspace')}, conversation ${created.id}, time zone Europe/Paris.`
    );
    assert.deepEqual(snapshot?.tools, TOOLS);
  });

  it('does not change the snapshot of existing conversations when the template changes', async () => {
    const { conversations } = service();
    const before = await conversations.create({});
    const frozen = await storage.promptSnapshots.getForOwner('conversation', before.id);

    await writeFile(join(dir, 'system.md'), 'A completely new prompt for {{name}}.');
    try {
      const after = await conversations.create({});
      const newSnapshot = await storage.promptSnapshots.getForOwner('conversation', after.id);
      assert.equal(newSnapshot?.systemPrompt, 'A completely new prompt for Artemis.');
      assert.notEqual(newSnapshot?.templateHash, frozen?.templateHash);

      const stillFrozen = await storage.promptSnapshots.getForOwner('conversation', before.id);
      assert.deepEqual(stillFrozen, frozen);
    } finally {
      await writeFile(join(dir, 'system.md'), TEMPLATE);
    }
  });

  it('stores an explicit title as a user title', async () => {
    const { conversations } = service();
    const created = await conversations.create({ title: '  Trip plans ' });
    assert.equal(created.title, 'Trip plans');
    const record = await storage.conversations.get(created.id);
    assert.equal(record?.titleSource, 'user');
  });

  it('renames with a user title and publishes the change', async () => {
    const events = new ConversationEventHub();
    const { conversations } = service(events);
    const created = await conversations.create({});
    const received: unknown[] = [];
    events.subscribe(created.id, (event) => received.push(event));

    const renamed = await conversations.rename(created.id, 'Renamed');
    assert.equal(renamed.title, 'Renamed');
    const record = await storage.conversations.get(created.id);
    assert.equal(record?.titleSource, 'user');
    assert.deepEqual(received.at(-1), { type: 'conversation_updated', conversation: renamed });
  });

  it('reports the unread count in create and rename summaries, as the list does', async () => {
    const { conversations } = service();
    const created = await conversations.create({});
    assert.equal(created.unread, 0);

    const task = await storage.tasks.create({
      id: 'task_unread',
      conversationId: created.id,
      kind: 'agent',
      status: 'running',
      title: 'Research',
      prompt: 'p',
      subagentType: 'general-purpose',
      command: null,
      cwd: null,
      outputPath: null,
      needsInput: false,
      originMode: 'text',
      originTurnId: null,
      originToolCallId: null,
      parentTaskId: null,
      resumedFromTaskId: null,
      depth: 0,
      model: null,
      startedAt: new Date().toISOString(),
    });
    await storage.updates.create({
      id: 'upd_unread',
      conversationId: created.id,
      taskId: task.id,
      title: task.title,
      status: 'completed',
      needsInput: false,
      report: 'Done',
      durationMs: 1,
      depth: 0,
      delivery: 'held',
      unread: true,
      createdAt: new Date().toISOString(),
    });

    const renamed = await conversations.rename(created.id, 'Renamed');
    assert.equal(renamed.unread, 1);
    const listed = await conversations.list({ limit: 10 });
    assert.equal(listed.items.find((item) => item.id === created.id)?.unread, renamed.unread);
  });

  it('archives and then reports the conversation as not found', async () => {
    const { conversations } = service();
    const created = await conversations.create({});
    await conversations.archive(created.id);
    await assert.rejects(conversations.require(created.id), NotFoundError);
  });

  it('reports context usage from the latest completed turn', async () => {
    const { conversations } = service();
    const created = await conversations.create({});
    assert.equal(await conversations.contextUsage(created.id), null);
  });
});
