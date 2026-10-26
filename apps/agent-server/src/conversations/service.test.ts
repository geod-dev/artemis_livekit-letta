import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type LlmRequest, LlmProvider, type LlmStreamEvent, type ModelInfo, ProviderRegistry, type ToolDefinition } from '@artemis/llm';
import { AppError, NotFoundError } from '@artemis/core';
import type { ConversationEvent } from '@artemis/contracts/chat-types';
import { EphemeralStorage } from '@artemis/storage/testing';
import { loadConfig } from '../config.ts';
import { ConversationEventHub } from '../events/hub.ts';
import { createModelRouter } from '../models/routing.ts';
import { PromptRenderer } from '../prompts/renderer.ts';
import type { TurnOutcome, TurnSubmission } from '../turns/types.ts';
import { createConversationService, type MainAgentHandle, type MainAgentPort } from './service.ts';

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
let storage: EphemeralStorage;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'conv-prompts-'));
  await writeFile(join(dir, 'system.md'), TEMPLATE);
  await writeFile(join(dir, 'worker-rules.md'), 'rules');
  await writeFile(join(dir, 'title.md'), 'title');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Test double: `members` names what the test uses; anything else is absent. */
function fake<T>(members: Partial<T>): T {
  return members as T;
}

/** A main agent that records the submissions it receives and completes each one at once. */
function recordingSupervisor(submitted: TurnSubmission[], busy = false): MainAgentPort {
  const outcome: TurnOutcome = { turnId: 'turn_test', status: 'completed', text: '' };
  const worker = fake<MainAgentHandle>({
    busy,
    submit(submission: TurnSubmission) {
      submitted.push(submission);
      return { turnId: outcome.turnId, done: Promise.resolve(outcome) };
    },
    cancel: () => true,
  });
  return { mainAgent: async () => worker, peekMainAgent: () => worker };
}

function service(events = new ConversationEventHub(), submitted: TurnSubmission[] = [], busy = false) {
  storage = new EphemeralStorage();
  const config = loadConfig({
    DATABASE_URL: 'postgresql://x',
    ASSISTANT_NAME: 'Artemis',
    ASSISTANT_TIMEZONE: 'Europe/Paris',
    ASSISTANT_TASK_MODEL: 'anthropic/claude-haiku-5-5',
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
      supervisor: recordingSupervisor(submitted, busy),
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
      `You are Artemis in /workspace, conversation ${created.id}, time zone Europe/Paris.`
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

  it('rewind returns 409 while the main agent is busy', async () => {
    const { conversations } = service(undefined, [], true);
    const created = await conversations.create({});
    await assert.rejects(conversations.rewind(created.id, 'msg_unknown'), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'turn_in_progress');
      assert.equal(error.status, 409);
      return true;
    });
  });

  it('rename of an archived conversation is refused and publishes nothing', async () => {
    const events = new ConversationEventHub();
    const { conversations } = service(events);
    const created = await conversations.create({});
    const received: ConversationEvent[] = [];
    events.subscribe(created.id, (event) => received.push(event));
    await conversations.archive(created.id);

    await assert.rejects(conversations.rename(created.id, 'Renamed'), NotFoundError);
    assert.equal(received.some((event) => event.type === 'conversation_updated'), false);
    const record = await storage.conversations.get(created.id, { includeArchived: true });
    assert.notEqual(record?.title, 'Renamed');
  });

  it('archives and then reports the conversation as not found', async () => {
    const { conversations } = service();
    const created = await conversations.create({});
    await conversations.archive(created.id);
    await assert.rejects(conversations.require(created.id), NotFoundError);
  });

  it('submits a text turn to the main agent with its effort and client id, and cancels through it', async () => {
    const submitted: TurnSubmission[] = [];
    const { conversations } = service(undefined, submitted);
    const created = await conversations.create({});

    const handle = await conversations.submitTurn(created.id, { text: 'hi', effort: 'high', clientMessageId: 'cm1' });
    assert.equal(handle.turnId, 'turn_test');
    assert.deepEqual(submitted, [
      { kind: 'user', modality: 'text', mode: 'text', text: 'hi', effort: 'high', clientMessageId: 'cm1' },
    ]);
    assert.equal(conversations.cancelTurn(created.id), true);
  });

  it('reports context usage from the latest completed turn', async () => {
    const { conversations } = service();
    const created = await conversations.create({});
    assert.equal(await conversations.contextUsage(created.id), null);
  });
});
