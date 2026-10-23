import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { Hono } from 'hono';
import type { ChatAttachment } from '@artemis/contracts/chat-types';
import { consoleLogger, systemClock } from '@artemis/core';
import { type LlmProvider, ProviderRegistry } from '@artemis/llm';
import { AnthropicLlmProvider } from '@artemis/llm/anthropic';
import { type ArtifactSink, McpCatalog, McpServerRegistry, type McpSettingsStore, mcpRevision } from '@artemis/mcp';
import { SdkMcpClient } from '@artemis/mcp/sdk';
import { MemoryStore, type RecallResult } from '@artemis/memory';
import type { Storage } from '@artemis/storage';
import { PostgresStorage } from '@artemis/storage/postgres';
import { FilesystemWorkspaceTransport } from '@artemis/workspace/filesystem';
import type { CallSessions } from '../calls/call-sessions.ts';
import { createCallSessions } from '../calls/call-sessions.ts';
import { loadConfig } from '../config.ts';
import { createConversationService } from '../conversations/service.ts';
import { ConversationEventHub } from '../events/hub.ts';
import { createMemoryCoordinator } from '../memory/coordinator.ts';
import { createMemoryTools } from '../memory/tools.ts';
import { createModelRouter } from '../models/routing.ts';
import { PromptRenderer } from '../prompts/renderer.ts';
import { loadSubagentDefinitions } from '../subagents/definitions.ts';
import { createTitleService } from '../titles/title-service.ts';
import { createAgentRuntime } from '../workers/runtime.ts';
import { createApp } from './app.ts';

/**
 * Integration tests: the real app wiring of `main.ts` (PostgresStorage, workers,
 * events, MCP registry) behind the Hono app, driven in-process with `app.request`.
 * Runs only when TEST_DATABASE_URL is set. The Anthropic client points at a closed
 * local port, so turns fail fast and offline instead of reaching the network.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = TEST_DATABASE_URL ? false : 'set TEST_DATABASE_URL to run the agent-server integration tests';

const TOKEN = `integration-${randomUUID()}`;
const UNREACHABLE_URL = 'http://127.0.0.1:9';
const PROMPTS_DIR = fileURLToPath(new URL('../../prompts', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Harness {
  app: Hono;
  events: ConversationEventHub;
  calls: CallSessions;
  close(): Promise<void>;
}

interface RequestOptions {
  body?: unknown;
  raw?: string;
  auth?: boolean;
  headers?: Record<string, string>;
}

async function request(h: Harness, method: string, path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.auth !== false) headers.authorization = `Bearer ${TOKEN}`;
  let body = options.raw;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  return h.app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) });
}

async function createConversation(h: Harness, title?: string): Promise<{ id: string; title: string; updatedAt: string }> {
  const response = await request(h, 'POST', '/v1/conversations', { body: title ? { title } : {} });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: string; title: string; updatedAt: string };
}

/** Reads an SSE response incrementally, with a deadline on every read. */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private text = '';

  constructor(response: Response) {
    this.reader = response.body!.getReader();
  }

  async until(done: (text: string) => boolean, timeoutMs = 5_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!done(this.text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`SSE timed out after ${timeoutMs} ms`);
      let timer: NodeJS.Timeout | undefined;
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`SSE read timed out after ${timeoutMs} ms`)), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) throw new Error('SSE stream closed before the expected event');
      this.text += this.decoder.decode(chunk.value, { stream: true });
    }
    return this.text;
  }

  /** The `data:` payloads of the complete frames read so far. */
  frames(): Array<Record<string, unknown>> {
    return this.text
      .split('\n\n')
      .slice(0, -1)
      .flatMap((block) => block.split('\n'))
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

/** Same wiring as `main.ts`, minus the HTTP server and the signal handlers. */
async function buildHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'agent-server-it-'));
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL!,
    AGENT_SERVER_TOKEN: TOKEN,
    ANTHROPIC_API_KEY: 'integration-test-key',
    ASSISTANT_TASK_MODEL: 'anthropic/claude-haiku-5-5',
    WORKSPACE_PATH: root,
  });
  const logger = consoleLogger('agent-server-it');
  const clock = systemClock;

  const storage: Storage = new PostgresStorage({ connectionString: config.databaseUrl });
  await storage.migrate();

  const providers: LlmProvider[] = [
    new AnthropicLlmProvider({ apiKey: 'integration-test-key', baseUrl: UNREACHABLE_URL, maxRetries: 0 }),
  ];
  const router = createModelRouter(config, new ProviderRegistry(providers));
  const prompts = new PromptRenderer(PROMPTS_DIR);
  const subagents = await loadSubagentDefinitions(join(PROMPTS_DIR, 'agents'));

  const memoryStore = new DisabledMemoryStore();
  const memory = createMemoryCoordinator({ store: memoryStore, storage, config, clock, logger: logger.child('memory') });
  memory.start();
  await memoryStore.ensureReady();

  const workspace = new FilesystemWorkspaceTransport({
    root: config.workspace.root,
    displayRoot: config.workspace.displayRoot,
    runAs: config.workspace.runAs,
    ripgrep: 'auto',
  });
  const mcpClient = new SdkMcpClient({ artifacts: workspaceArtifactSink(workspace), stdio: { cwd: config.workspace.root } });
  const catalog: McpCatalog = new McpCatalog(mcpClient, () => registry.servers());
  const registry: McpServerRegistry = new McpServerRegistry(
    mcpSettingsStore(storage),
    () => catalog.refresh().then(() => undefined),
    () => catalog.status()
  );
  await registry.load();
  await catalog.refresh();

  const events = new ConversationEventHub(clock);
  const titles = createTitleService({ storage, router, prompts, events, logger: logger.child('titles') });
  const calls = createCallSessions(clock);
  const runtime = createAgentRuntime({
    config,
    storage,
    router,
    prompts,
    subagents,
    hub: events,
    memory,
    calls,
    titles,
    workspace,
    catalog,
    mcp: mcpClient,
    memoryTools: createMemoryTools({ store: memoryStore, config, clock, logger: logger.child('memory-tools') }),
    present: false,
    clock,
    logger: logger.child('agent'),
  });
  const { supervisor, delivery, tools } = runtime;
  calls.onEnded((conversationId, pending) => {
    void delivery.callEnded(conversationId, pending);
  });

  const conversations = createConversationService({
    storage,
    prompts,
    router,
    events,
    config,
    toolDefinitions: () => tools.definitions(),
    pendingRows: (conversationId) => delivery.eventRows(conversationId),
    onArchived: (conversationId) => supervisor.stopConversation(conversationId),
  });

  await supervisor.recover();
  supervisor.start();

  const app = createApp({
    config,
    conversations,
    supervisor,
    tasks: runtime.tasks,
    delivery,
    calls,
    events,
    mcp: registry,
    ready: async () => ({
      storage: await storage.healthy(),
      mcp: catalog.status().refreshedAt !== null,
      memory: await memoryStore.healthy(),
    }),
  });

  return {
    app,
    events,
    calls,
    close: async () => {
      await supervisor.shutdown();
      await memory.stop();
      await titles.stop();
      events.close();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Memory disabled (no HINDSIGHT_URL), as in `main.ts`. */
class DisabledMemoryStore extends MemoryStore {
  async ensureReady(): Promise<void> {}

  async retain(): Promise<{ operationId: string }> {
    return { operationId: 'disabled' };
  }

  async recall(): Promise<RecallResult> {
    return { facts: [] };
  }

  async healthy(): Promise<boolean> {
    return false;
  }
}

function mcpSettingsStore(storage: Storage): McpSettingsStore {
  return {
    async load() {
      const record = await storage.mcpSettings.get();
      return record
        ? { servers: record.servers, invalidEntries: record.invalidEntries, revision: record.revision }
        : { servers: [], invalidEntries: [], revision: null };
    },
    async save(servers, invalidEntries, expectedRevision) {
      const revision = mcpRevision(servers);
      const record = await storage.mcpSettings.save({ servers, invalidEntries, revision }, expectedRevision);
      return record.revision;
    },
  };
}

function workspaceArtifactSink(workspace: FilesystemWorkspaceTransport): ArtifactSink {
  return {
    async save({ conversationId, name, mimeType, bytes }) {
      const safeName = name.replace(/[^\w.-]+/g, '_') || 'artifact';
      const path = `data/artifacts/${conversationId}/${randomUUID()}-${safeName}`;
      await workspace.makeDirectory(`data/artifacts/${conversationId}`);
      await workspace.writeFile(path, bytes);
      const attachment: ChatAttachment = {
        path,
        name,
        kind: mimeType.startsWith('image/') ? 'image' : 'file',
        mimeType,
        size: bytes.byteLength,
      };
      return attachment;
    },
  };
}

describe('agent-server HTTP API against real storage and workers', { skip }, () => {
  let h: Harness;

  before(async () => {
    h = await buildHarness();
  }, { timeout: 60_000 });

  after(async () => {
    await h?.close();
  });

  it('health is open and ready reports real storage and the MCP catalog as ready', async () => {
    const health = await request(h, 'GET', '/health', { auth: false });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const ready = await request(h, 'GET', '/ready', { auth: false });
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'degraded', storage: true, mcp: true, memory: false });
  });

  it('an unknown path is a 404 with the stable not_found code', async () => {
    const response = await request(h, 'GET', '/no-such-route', { auth: false });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, 'not_found');
  });

  it('every /v1 route rejects a missing or wrong bearer token with 401', async () => {
    const id = randomUUID();
    const routes: Array<[string, string]> = [
      ['GET', '/v1/conversations'],
      ['POST', '/v1/conversations'],
      ['GET', '/v1/conversations/events'],
      ['GET', `/v1/conversations/${id}`],
      ['PATCH', `/v1/conversations/${id}`],
      ['DELETE', `/v1/conversations/${id}`],
      ['GET', `/v1/conversations/${id}/events`],
      ['GET', `/v1/conversations/${id}/messages`],
      ['DELETE', `/v1/conversations/${id}/messages/${id}`],
      ['POST', `/v1/conversations/${id}/turns`],
      ['POST', `/v1/conversations/${id}/cancel`],
      ['POST', `/v1/conversations/${id}/warm`],
      ['GET', `/v1/conversations/${id}/context-usage`],
      ['GET', `/v1/conversations/${id}/tasks`],
      ['GET', `/v1/conversations/${id}/tasks/task-1`],
      ['POST', `/v1/conversations/${id}/tasks/task-1/cancel`],
      ['POST', `/v1/conversations/${id}/read`],
      ['GET', '/v1/mcp'],
      ['PUT', '/v1/mcp'],
      ['PUT', '/v1/mcp/managed'],
      ['POST', `/v1/voice/conversations/${id}/chat/completions`],
      ['GET', `/v1/voice/conversations/${id}/call`],
      ['GET', `/v1/voice/conversations/${id}/call/state`],
      ['POST', `/v1/voice/conversations/${id}/call/updates/u1`],
      ['POST', `/v1/voice/conversations/${id}/call/updates/u1/ack`],
      ['POST', `/v1/voice/conversations/${id}/ended`],
    ];
    for (const [method, path] of routes) {
      const missing = await request(h, method, path, { auth: false });
      assert.equal(missing.status, 401, `${method} ${path} without a token`);
      assert.equal(((await missing.json()) as { code: string }).code, 'unauthorized', `${method} ${path}`);

      const wrong = await request(h, method, path, { auth: false, headers: { authorization: 'Bearer not-the-token' } });
      assert.equal(wrong.status, 401, `${method} ${path} with a wrong token`);
    }
  });

  it('POST /v1/conversations returns a UUID id that round-trips through GET', async () => {
    const created = await createConversation(h);
    assert.match(created.id, UUID);
    assert.equal(created.title, 'New chat');
    assert.equal(typeof created.updatedAt, 'string');

    const fetched = await request(h, 'GET', `/v1/conversations/${created.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(((await fetched.json()) as { id: string }).id, created.id);

    const messages = await request(h, 'GET', `/v1/conversations/${created.id}/messages`);
    assert.equal(messages.status, 200);
    assert.deepEqual(await messages.json(), []);
  });

  it('a conversation is created, renamed, read, listed and archived', async () => {
    const created = await createConversation(h, '  Lifecycle  ');
    assert.equal(created.title, 'Lifecycle', 'the title is trimmed on create');

    const renamed = await request(h, 'PATCH', `/v1/conversations/${created.id}`, { body: { title: 'Renamed' } });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { title: string }).title, 'Renamed');

    const fetched = await request(h, 'GET', `/v1/conversations/${created.id}`);
    assert.equal(((await fetched.json()) as { title: string }).title, 'Renamed');

    const listed = await request(h, 'GET', '/v1/conversations?limit=200');
    assert.equal(listed.status, 200);
    const items = (await listed.json()) as Array<{ id: string; title: string }>;
    assert.ok(items.some((item) => item.id === created.id && item.title === 'Renamed'), 'the list contains the renamed conversation');

    const archived = await request(h, 'DELETE', `/v1/conversations/${created.id}`);
    assert.equal(archived.status, 204);
    assert.equal(await archived.text(), '');

    const gone = await request(h, 'GET', `/v1/conversations/${created.id}`);
    assert.equal(gone.status, 404);
    assert.equal(((await gone.json()) as { code: string }).code, 'not_found');

    const relisted = (await (await request(h, 'GET', '/v1/conversations?limit=200')).json()) as Array<{ id: string }>;
    assert.ok(!relisted.some((item) => item.id === created.id), 'an archived conversation leaves the list');

    const again = await request(h, 'DELETE', `/v1/conversations/${created.id}`);
    assert.equal(again.status, 404);
  });

  it('the conversation list pages with limit and X-Next-Cursor', async () => {
    await createConversation(h);
    await createConversation(h);
    const first = await request(h, 'GET', '/v1/conversations?limit=1');
    assert.equal(first.status, 200);
    const [item] = (await first.json()) as Array<{ id: string }>;
    assert.equal(item && typeof item.id, 'string');
    const cursor = first.headers.get('X-Next-Cursor');
    assert.ok(cursor, 'a second page exists');

    const second = await request(h, 'GET', `/v1/conversations?limit=1&after=${cursor}`);
    assert.equal(second.status, 200);
    const [next] = (await second.json()) as Array<{ id: string }>;
    assert.notEqual(next?.id, item?.id);
  });

  it('invalid conversation input is a 400 with a stable code', async () => {
    const created = await createConversation(h);
    const cases: Array<[string, string, RequestOptions, string]> = [
      ['POST', '/v1/conversations', { body: { title: 42 } }, 'invalid_field'],
      ['POST', '/v1/conversations', { raw: '{"title": ' }, 'invalid_body'],
      ['PATCH', `/v1/conversations/${created.id}`, { body: {} }, 'invalid_field'],
      ['PATCH', `/v1/conversations/${created.id}`, { body: { title: '   ' } }, 'invalid_title'],
      ['GET', '/v1/conversations?limit=0', {}, 'invalid_limit'],
      ['GET', '/v1/conversations?limit=201', {}, 'invalid_limit'],
      ['GET', `/v1/conversations/${created.id}/messages?limit=abc`, {}, 'invalid_limit'],
      ['POST', `/v1/conversations/${created.id}/turns`, { body: { text: '   ' } }, 'invalid_field'],
      ['POST', `/v1/conversations/${created.id}/turns`, { body: { text: 'hi', effort: 'extreme' } }, 'invalid_field'],
      ['POST', `/v1/conversations/${created.id}/turns`, { body: { text: 7 } }, 'invalid_field'],
      ['POST', `/v1/conversations/${created.id}/read`, { body: { updateIds: 'one' } }, 'invalid_field'],
      ['POST', `/v1/conversations/${created.id}/read`, { body: { updateIds: [1] } }, 'invalid_field'],
      ['POST', `/v1/conversations/${created.id}/read`, { body: { updateIds: ['not-a-uuid'] } }, 'invalid_field'],
    ];
    for (const [method, path, options, code] of cases) {
      const response = await request(h, method, path, options);
      assert.equal(response.status, 400, `${method} ${path}`);
      assert.equal(((await response.json()) as { code: string }).code, code, `${method} ${path}`);
    }
  });

  it('routes answer 404 not_found for an unknown conversation id', async () => {
    const id = randomUUID();
    const message = randomUUID();
    const cases: Array<[string, string, unknown?]> = [
      ['GET', `/v1/conversations/${id}`],
      ['PATCH', `/v1/conversations/${id}`, { title: 'x' }],
      ['DELETE', `/v1/conversations/${id}`],
      ['GET', `/v1/conversations/${id}/events`],
      ['GET', `/v1/conversations/${id}/messages`],
      ['DELETE', `/v1/conversations/${id}/messages/${message}`],
      ['POST', `/v1/conversations/${id}/turns`, { text: 'hi' }],
      ['POST', `/v1/conversations/${id}/warm`],
      ['GET', `/v1/conversations/${id}/context-usage`],
      ['GET', `/v1/conversations/${id}/tasks`],
      ['GET', `/v1/conversations/${id}/tasks/task-1`],
      ['POST', `/v1/voice/conversations/${id}/chat/completions`, { messages: [{ role: 'user', content: 'hi' }] }],
      ['GET', `/v1/voice/conversations/${id}/call`],
      ['GET', `/v1/voice/conversations/${id}/call/state`],
      ['POST', `/v1/voice/conversations/${id}/call/updates/u1`],
      ['POST', `/v1/voice/conversations/${id}/call/updates/u1/ack`, { heard: true }],
      ['POST', `/v1/voice/conversations/${id}/ended`],
    ];
    for (const [method, path, body] of cases) {
      const response = await request(h, method, path, body === undefined ? {} : { body });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(((await response.json()) as { code: string }).code, 'not_found', `${method} ${path}`);
    }
  });

  it('a conversation id that is not a UUID is a 404 on every conversation route, not a server error', async () => {
    const cases: Array<[string, string]> = [
      ['GET', '/v1/conversations/not-a-uuid'],
      ['GET', '/v1/conversations/not-a-uuid/tasks'],
      ['GET', '/v1/voice/conversations/not-a-uuid/call/state'],
      ['POST', '/v1/voice/conversations/not-a-uuid/ended'],
    ];
    const notFound: string[] = [];
    for (const [method, path] of cases) {
      const response = await request(h, method, path);
      if (response.status !== 404) notFound.push(`${method} ${path} -> ${response.status}`);
    }
    assert.deepEqual(notFound, [], 'every route answers 404 for a non-UUID conversation id');
  });

  it('a turn is accepted with 202 and a turnId, and can be cancelled', async () => {
    const created = await createConversation(h);
    const accepted = await request(h, 'POST', `/v1/conversations/${created.id}/turns`, {
      body: { text: 'hello', clientMessageId: 'cm-integration-1' },
    });
    assert.equal(accepted.status, 202);
    const turn = (await accepted.json()) as { accepted: boolean; turnId: string };
    assert.equal(turn.accepted, true);
    assert.equal(typeof turn.turnId, 'string');
    assert.ok(turn.turnId.length > 0);

    const cancel = await request(h, 'POST', `/v1/conversations/${created.id}/cancel`);
    assert.equal(cancel.status, 200);
    assert.equal(typeof ((await cancel.json()) as { cancelled: unknown }).cancelled, 'boolean');
  });

  it('warm, context usage, tasks and read answer for a fresh conversation', async () => {
    const created = await createConversation(h);
    const base = `/v1/conversations/${created.id}`;

    const warm = await request(h, 'POST', `${base}/warm`);
    assert.equal(warm.status, 204);

    const usage = await request(h, 'GET', `${base}/context-usage`);
    assert.equal(usage.status, 200);
    assert.equal(await usage.json(), null, 'no turn has reported usage yet');

    const tasks = await request(h, 'GET', `${base}/tasks`);
    assert.equal(tasks.status, 200);
    assert.deepEqual(await tasks.json(), []);

    const missingTask = await request(h, 'GET', `${base}/tasks/task-missing`);
    assert.equal(missingTask.status, 404);
    assert.equal(((await missingTask.json()) as { code: string }).code, 'not_found');

    const stopped = await request(h, 'POST', `${base}/tasks/task-missing/cancel`);
    assert.equal(stopped.status, 200);
    assert.deepEqual(await stopped.json(), { cancelled: false });

    const read = await request(h, 'POST', `${base}/read`, { body: { updateIds: [] } });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { read: 0 });
  });

  it('rewinding an unknown message in a real conversation is a 404', async () => {
    const created = await createConversation(h);
    const response = await request(h, 'DELETE', `/v1/conversations/${created.id}/messages/${randomUUID()}`);
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, 'not_found');
  });

  it('MCP settings: GET carries a revision ETag, PUT needs a matching If-Match, invalid servers are 400', async () => {
    const current = await request(h, 'GET', '/v1/mcp');
    assert.equal(current.status, 200);
    const settings = (await current.json()) as { servers: unknown[]; revision: string };
    assert.ok(Array.isArray(settings.servers));
    assert.equal(current.headers.get('ETag'), `"${settings.revision}"`);

    const unconditional = await request(h, 'PUT', '/v1/mcp', { body: { servers: [] } });
    assert.equal(unconditional.status, 428);
    assert.equal(((await unconditional.json()) as { code: string }).code, 'precondition_required');

    const stale = await request(h, 'PUT', '/v1/mcp', {
      body: { servers: [] },
      headers: { 'if-match': '"stale-revision"' },
    });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { code: string }).code, 'revision_conflict');

    const invalid = await request(h, 'PUT', '/v1/mcp', {
      body: { servers: ['not-a-server'] },
      headers: { 'if-match': `"${settings.revision}"` },
    });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { code: string }).code, 'invalid_mcp_servers');

    const saved = await request(h, 'PUT', '/v1/mcp', {
      body: { servers: [] },
      headers: { 'if-match': `"${settings.revision}"` },
    });
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { servers: unknown[]; revision: string };
    assert.deepEqual(body.servers, []);
    assert.equal(saved.headers.get('ETag'), `"${body.revision}"`);
    assert.equal(body.revision, settings.revision, 'an unchanged list keeps its revision');
  });

  it('managed MCP servers: an unmanaged entry is a 400, an empty list is 204', async () => {
    const unmanaged = await request(h, 'PUT', '/v1/mcp/managed', {
      body: { servers: [{ name: 'manual-http', transport: 'http', url: `${UNREACHABLE_URL}/mcp` }] },
    });
    assert.equal(unmanaged.status, 400);
    assert.equal(((await unmanaged.json()) as { code: string }).code, 'invalid_mcp_servers');

    const empty = await request(h, 'PUT', '/v1/mcp/managed', { body: { servers: [] } });
    assert.equal(empty.status, 204);
  });

  it('a per-conversation event stream sends a snapshot, then the events published to it', async () => {
    const created = await createConversation(h);
    const response = await request(h, 'GET', `/v1/conversations/${created.id}/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const sse = new SseReader(response);
    try {
      await sse.until((text) => text.includes('"type":"snapshot"'));
      h.events.publish(created.id, { type: 'turn_start', turnId: 'turn-sse-1', modality: 'text' });
      await sse.until((text) => text.includes('"turnId":"turn-sse-1"'));
      const received = sse.frames().find((event) => event.type === 'turn_start' && event.turnId === 'turn-sse-1');
      assert.deepEqual(received, { type: 'turn_start', turnId: 'turn-sse-1', modality: 'text' });
    } finally {
      await sse.close();
    }
  });

  it('the conversation list event stream delivers list events to a subscriber', async () => {
    const response = await request(h, 'GET', '/v1/conversations/events');
    assert.equal(response.status, 200);
    const sse = new SseReader(response);
    try {
      await sse.until((text) => text.includes(': connected'));
      h.events.publishList({ type: 'unread', conversationId: 'conv-list-1', unread: 3 });
      await sse.until((text) => text.includes('"conversationId":"conv-list-1"'));
      const received = sse.frames().find((event) => event.conversationId === 'conv-list-1');
      assert.deepEqual(received, { type: 'unread', conversationId: 'conv-list-1', unread: 3 });
    } finally {
      await sse.close();
    }
  });

  it('the voice call control channel opens as an event stream and the call state defaults to short/listen', async () => {
    const created = await createConversation(h);
    const state = await request(h, 'GET', `/v1/voice/conversations/${created.id}/call/state`);
    assert.equal(state.status, 200);
    assert.deepEqual(await state.json(), { mode: 'short', next: 'listen' });

    const channel = await request(h, 'GET', `/v1/voice/conversations/${created.id}/call?mode=long`);
    assert.equal(channel.status, 200);
    assert.match(channel.headers.get('content-type') ?? '', /text\/event-stream/);
    const sse = new SseReader(channel);
    try {
      await sse.until((text) => text.includes(': connected'));
    } finally {
      await sse.close();
      // Closing the last channel starts a reconnect grace timer that ends the call later; end it now, while storage is open.
      h.calls.end(created.id);
    }
  });

  it('a voice completion on an open call runs a real turn and closes its stream with [DONE]', { timeout: 60_000 }, async () => {
    const created = await createConversation(h);
    const callId = `call-it-${randomUUID()}`;
    h.calls.openChannel(created.id, () => undefined, 'short');

    const response = await request(h, 'POST', `/v1/voice/conversations/${created.id}/chat/completions`, {
      body: { messages: [{ role: 'user', content: 'hello from the call', id: `lk-${callId}` }] },
      headers: { 'x-voice-call-id': callId },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await response.text();
    h.calls.end(created.id);
    assert.match(body, /"finish_reason":"stop"/);
    assert.ok(body.endsWith('data: [DONE]\n\n'), 'the stream ends with the DONE marker');
  });

  it('a non-UUID update id is a 404, not a server error', async () => {
    const created = await createConversation(h);
    const response = await request(h, 'POST', `/v1/voice/conversations/${created.id}/call/updates/update-missing`);
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, 'not_found');
  });

  it('voice updates: an unknown update is a 404, an ack needs a boolean, and ending a call is 204', async () => {
    const created = await createConversation(h);
    const base = `/v1/voice/conversations/${created.id}`;
    const update = randomUUID();

    const unknown = await request(h, 'POST', `${base}/call/updates/${update}`);
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { code: string }).code, 'not_found');

    const badAck = await request(h, 'POST', `${base}/call/updates/${update}/ack`, { body: { heard: 'yes' } });
    assert.equal(badAck.status, 400);
    assert.equal(((await badAck.json()) as { code: string }).code, 'invalid_field');

    const ack = await request(h, 'POST', `${base}/call/updates/${update}/ack`, { body: { heard: true } });
    assert.equal(ack.status, 204);

    const ended = await request(h, 'POST', `${base}/ended`);
    assert.equal(ended.status, 204);
  });
});
