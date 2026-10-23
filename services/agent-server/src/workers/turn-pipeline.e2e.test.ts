import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ConversationEvent } from '@artemis/contracts/chat-types';
import { BusyError } from '@artemis/core';
import type { LlmRequest } from '@artemis/llm';
import { McpCatalog, McpClient } from '@artemis/mcp';
import type { Storage } from '@artemis/storage';
import { PostgresStorage } from '@artemis/storage/postgres';
import { FilesystemWorkspaceTransport } from '@artemis/workspace/filesystem';
import type { AgentServerConfig } from '../config.ts';
import { createCallSessions } from '../calls/call-sessions.ts';
import { MemoryCoordinator } from '../memory/coordinator.ts';
import { PromptRenderer } from '../prompts/renderer.ts';
import { TitleService } from '../titles/title-service.ts';
import { type AgentRuntime, createAgentRuntime } from './runtime.ts';
import { FixedRouter, ManualClock, RecordingHub, ScriptedProvider, silentLogger, type Step, testConfig, until } from './test-support.ts';
import type { TurnSubmission } from './types.ts';

/**
 * End-to-end turn pipeline over real Postgres: the main agent worker, the events hub,
 * the background delivery and the storage repositories, driven by a scripted model.
 * Runs when TEST_DATABASE_URL is set (the server URL; each suite creates and drops
 * its own database on that server).
 */
const serverUrl = process.env.TEST_DATABASE_URL;
const skip = serverUrl === undefined ? 'set TEST_DATABASE_URL to run the turn pipeline e2e tests' : false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANSWER = 'Hi from the fake model';

/** `pg` is a dependency of the storage package, not of the agent server: resolve it from there. */
const requireFromStorage = createRequire(import.meta.resolve('@artemis/storage/postgres'));
const { Pool } = requireFromStorage('pg') as { Pool: new (options: { connectionString: string }) => PgPool };
interface PgPool {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

const textTurn = (text: string): TurnSubmission => ({ kind: 'user', modality: 'text', mode: 'text', effort: 'medium', text });

/** Last user message of a request, as plain text (tool results and updates included). */
function lastUserText(request: LlmRequest): string {
  const last = request.messages.at(-1);
  if (!last || last.role !== 'user') return '';
  return last.content
    .map((block) => (block.type === 'text' ? block.text : block.type === 'tool_result' ? block.content.map((c) => (c.type === 'text' ? c.text : '')).join('') : ''))
    .join('\n');
}

/** A scripted model that can be switched to fail every call (provider outage). */
class FlakyProvider extends ScriptedProvider {
  failing = false;

  override async *stream(request: LlmRequest, signal?: AbortSignal) {
    if (this.failing) throw new Error('upstream model unavailable');
    yield* super.stream(request, signal);
  }
}

class FixedPrompts extends PromptRenderer {
  constructor() {
    super('');
  }

  override async system() {
    return { templateId: 'system', templateHash: 'test', systemPrompt: 'MAIN-SYSTEM' };
  }

  override async subagent() {
    return { templateId: 'agent:general-purpose', templateHash: 'test', systemPrompt: 'SUB-SYSTEM' };
  }
}

class NoMemory extends MemoryCoordinator {
  async conversationActivated(): Promise<void> {}
  async recallFor(): Promise<[]> {
    return [];
  }
  async turnCompleted(): Promise<void> {}
  async flush(): Promise<void> {}
  start(): void {}
  async stop(): Promise<void> {}
}

class NoTitles extends TitleService {
  request(): void {}
  async stop(): Promise<void> {}
}

class NoMcp extends McpClient {
  async listTools(): Promise<never[]> {
    return [];
  }
  async callTool(): Promise<never> {
    throw new Error('MCP is not used in these tests');
  }
  async close(): Promise<void> {}
}

interface Rig {
  hub: RecordingHub;
  runtime: AgentRuntime;
}

/** The real runtime over `storage`, a scripted provider and a temp workspace. */
async function buildRig(storage: Storage, provider: ScriptedProvider, overrides: Partial<AgentServerConfig['workers']> = {}): Promise<Rig> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'turn-pipeline-'));
  const config = testConfig(workspaceRoot, overrides);
  const clock = new ManualClock();
  const hub = new RecordingHub();
  const catalog = new McpCatalog(new NoMcp(), () => [], { now: () => clock.now() });
  const runtime = createAgentRuntime({
    config,
    storage,
    router: new FixedRouter(provider),
    prompts: new FixedPrompts(),
    subagents: [{ name: 'general-purpose', description: 'General work', instructions: 'Do the task.' }],
    hub,
    memory: new NoMemory(),
    calls: createCallSessions(clock),
    titles: new NoTitles(),
    workspace: new FilesystemWorkspaceTransport({ root: workspaceRoot, displayRoot: '/workspace' }),
    catalog,
    mcp: new NoMcp(),
    memoryTools: [],
    present: false,
    clock,
    logger: silentLogger,
  });
  return { hub, runtime };
}

/** Creates a conversation with a uuid id and the runtime's frozen snapshot. */
async function newConversation(storage: Storage, runtime: AgentRuntime): Promise<string> {
  const id = randomUUID();
  await storage.conversations.create(
    { id, title: null, titleSource: null },
    {
      systemPrompt: 'MAIN-SYSTEM',
      tools: runtime.tools.definitions() as unknown[],
      templateId: 'system',
      templateHash: 'test',
    }
  );
  return id;
}

/** Live `turn_end` events of the hub, in publication order. */
function turnEnds(hub: RecordingHub): Extract<ConversationEvent, { type: 'turn_end' }>[] {
  return hub.events
    .map(({ event }) => event)
    .filter((event): event is Extract<ConversationEvent, { type: 'turn_end' }> => event.type === 'turn_end');
}

describe('turn pipeline over Postgres', { skip }, () => {
  let storage: PostgresStorage;
  let databaseName: string;

  before(async () => {
    databaseName = `artemis_turns_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: serverUrl ?? '' });
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await admin.end();
    }
    const url = new URL(serverUrl ?? '');
    url.pathname = `/${databaseName}`;
    storage = new PostgresStorage({ connectionString: url.toString() });
    await storage.migrate();
  });

  after(async () => {
    await storage?.close();
    const cleanup = new Pool({ connectionString: serverUrl ?? '' });
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  });

  test('a text turn persists uuid-keyed rows, publishes turn_start then a successful turn_end and touches last_message_at', async () => {
    const provider = new ScriptedProvider(() => ({ content: [{ type: 'text', text: ANSWER }] }));
    const { hub, runtime } = await buildRig(storage, provider);
    try {
      const id = await newConversation(storage, runtime);
      const worker = await runtime.supervisor.mainAgent(id);
      const handle = worker.submit(textTurn('hello'));
      const outcome = await handle.done;

      assert.equal(outcome.status, 'completed');
      assert.match(handle.turnId, UUID);
      const turn = await storage.turns.get(handle.turnId);
      assert.equal(turn?.status, 'completed');
      assert.equal(turn?.conversationId, id);
      assert.equal(turn?.kind, 'user');

      const transcript = await storage.messages.transcript(id, null);
      assert.deepEqual(transcript.map((message) => message.role), ['user', 'assistant']);
      for (const message of transcript) {
        assert.match(message.id, UUID);
        assert.equal(message.conversationId, id);
        assert.equal(message.turnId, handle.turnId);
      }
      assert.equal(transcript[0]?.envelope?.text, 'hello');
      assert.deepEqual(transcript[1]?.content, [{ type: 'text', text: ANSWER }]);

      const lifecycle = hub.events
        .filter(({ conversationId, event }) => conversationId === id && (event.type === 'turn_start' || event.type === 'turn_end'))
        .map(({ event }) => event);
      assert.deepEqual(lifecycle, [
        { type: 'turn_start', turnId: handle.turnId, modality: 'text' },
        { type: 'turn_end', turnId: handle.turnId, success: true },
      ]);

      const conversation = await storage.conversations.get(id);
      assert.ok(turn, 'turn row exists');
      assert.equal(conversation?.lastMessageAt, turn.startedAt);
    } finally {
      await runtime.supervisor.shutdown();
    }
  });

  test('a provider error ends the turn as failed with an error turn_end, and the worker accepts the next turn', async () => {
    const provider = new FlakyProvider(() => ({ content: [{ type: 'text', text: 'Recovered' }] }));
    provider.failing = true;
    const { hub, runtime } = await buildRig(storage, provider);
    try {
      const id = await newConversation(storage, runtime);
      const worker = await runtime.supervisor.mainAgent(id);
      const failed = worker.submit(textTurn('this one fails'));
      const outcome = await failed.done;

      assert.equal(outcome.status, 'failed');
      assert.match(outcome.error ?? '', /upstream model unavailable/);
      const turn = await storage.turns.get(failed.turnId);
      assert.notEqual(turn?.status, 'running', 'the failed turn is not left running');
      assert.equal(turn?.status, 'failed');
      assert.match(turn?.error ?? '', /upstream model unavailable/);
      const end = turnEnds(hub).find((event) => event.turnId === failed.turnId);
      assert.equal(end?.success, false);
      assert.match(end?.error ?? '', /upstream model unavailable/);

      provider.failing = false;
      const next = worker.submit(textTurn('try again'));
      assert.equal((await next.done).status, 'completed');
      assert.equal((await storage.turns.get(next.turnId))?.status, 'completed');
    } finally {
      await runtime.supervisor.shutdown();
    }
  });

  test('a second turn submitted while the queue is full is rejected with BusyError and the first turn still completes its cancel', async () => {
    const provider = new ScriptedProvider(() => ({ content: [{ type: 'text', text: 'Partial' }], hangUntilAbort: true }));
    const { hub, runtime } = await buildRig(storage, provider, { maxPendingTurns: 1 });
    try {
      const id = await newConversation(storage, runtime);
      const worker = await runtime.supervisor.mainAgent(id);
      const running = worker.submit(textTurn('first, still running'));
      await until(() => hub.events.some(({ event }) => event.type === 'turn_start'));

      assert.throws(
        () => worker.submit(textTurn('second, while the first runs')),
        (error: unknown) => error instanceof BusyError
      );

      assert.equal(worker.cancel(), true);
      assert.equal((await running.done).status, 'cancelled');
      assert.equal((await storage.turns.get(running.turnId))?.status, 'cancelled');
    } finally {
      await runtime.supervisor.shutdown();
    }
  });

  test('a tool call is persisted with its text id, its result and the turn id', async () => {
    let requests = 0;
    const provider = new ScriptedProvider((): Step => {
      requests += 1;
      if (requests === 1) {
        return {
          content: [{ type: 'tool_use', id: 'toolu_pg_echo', name: 'bash', input: { command: 'echo pg-tool-ok', description: 'echo' } }],
        };
      }
      return { content: [{ type: 'text', text: 'Tool finished' }] };
    });
    // Keep the command synchronous: a backgrounded call would not carry its result here.
    const { runtime } = await buildRig(storage, provider, { backgroundAfterMs: 60_000 });
    try {
      const id = await newConversation(storage, runtime);
      const worker = await runtime.supervisor.mainAgent(id);
      const handle = worker.submit(textTurn('run an echo'));
      assert.equal((await handle.done).status, 'completed');

      const transcript = await storage.messages.transcript(id, null);
      assert.deepEqual(transcript.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
      const assistantWithCall = transcript[1];
      assert.ok(assistantWithCall);
      assert.equal(assistantWithCall.turnId, handle.turnId);

      const calls = await storage.toolCalls.listForMessages([assistantWithCall.id]);
      assert.equal(calls.length, 1);
      const call = calls[0];
      assert.equal(call?.id, 'toolu_pg_echo');
      assert.equal(call?.name, 'bash');
      assert.equal(call?.assistantMessageId, assistantWithCall.id);
      assert.equal(call?.turnId, handle.turnId);
      assert.equal(call?.status, 'completed');
      assert.match(call?.resultText ?? '', /pg-tool-ok/);
      assert.equal(transcript[2]?.turnId, handle.turnId);
    } finally {
      await runtime.supervisor.shutdown();
    }
  });

  test('a finished background task becomes an update that an update turn delivers', async () => {
    const provider = new ScriptedProvider((request) =>
      lastUserText(request).includes('<background-update')
        ? { content: [{ type: 'text', text: 'Noted the report' }] }
        : { content: [{ type: 'text', text: 'unused' }] }
    );
    const { hub, runtime } = await buildRig(storage, provider);
    try {
      const id = await newConversation(storage, runtime);
      const taskId = `task_pg_${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      await storage.tasks.create({
        id: taskId,
        conversationId: id,
        kind: 'agent',
        status: 'running',
        title: 'Survey',
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
        startedAt: now,
      });
      const finished = await storage.tasks.finish(taskId, {
        status: 'completed',
        report: 'Report body',
        needsInput: false,
        exitCode: null,
        stdoutTail: null,
        stderrTail: null,
        usage: null,
        endedAt: new Date().toISOString(),
      });
      const created = await runtime.delivery.taskFinished(finished!);
      assert.ok(created);
      assert.match(created.id, UUID);

      await until(async () => (await storage.updates.get(created.id))?.delivery === 'delivered');
      const stored = await storage.updates.get(created.id);
      assert.equal(stored?.status, 'completed');
      assert.equal(stored?.taskId, taskId);
      assert.match(stored?.deliveredTurnId ?? '', UUID);

      const updateTurn = await storage.turns.get(stored?.deliveredTurnId ?? '');
      assert.equal(updateTurn?.kind, 'update');
      assert.equal(updateTurn?.conversationId, id);
      assert.equal(updateTurn?.status, 'completed');
      assert.ok(provider.requests.some((request) => lastUserText(request).includes('<background-update')));
      await until(() => turnEnds(hub).some((event) => event.turnId === updateTurn?.id && event.success === true));
    } finally {
      await runtime.supervisor.shutdown();
    }
  });
});
