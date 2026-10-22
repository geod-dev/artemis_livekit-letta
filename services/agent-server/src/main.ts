/**
 * Composition root: the only module that imports vendor implementations
 * (`@artemis/llm/anthropic`, `@artemis/llm/openai-compatible`,
 * `@artemis/storage/postgres`, `@artemis/memory/hindsight`,
 * `@artemis/workspace/filesystem`, `@artemis/mcp/sdk`).
 *
 * Boot: loadConfig -> PostgresStorage.migrate -> memory coordinator start ->
 * MCP registry load + catalog refresh -> supervisor.recover -> memory.ensureReady
 * (non-blocking) -> supervisor/outbox start -> serve (Hono on AGENT_SERVER_PORT).
 * SIGTERM: stop accepting, stop workers (tasks end `failed: interrupted`), flush
 * the last active conversation's memory, stop the outbox, close storage.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { AnthropicLlmProvider } from '@artemis/llm/anthropic';
import { OpenAiCompatibleLlmProvider } from '@artemis/llm/openai-compatible';
import { type LlmProvider, ProviderRegistry } from '@artemis/llm';
import { consoleLogger, systemClock } from '@artemis/core';
import type { ChatAttachment } from '@artemis/contracts/chat-types';
import { type ArtifactSink, McpCatalog, McpServerRegistry, type McpSettingsStore, mcpRevision } from '@artemis/mcp';
import { SdkMcpClient } from '@artemis/mcp/sdk';
import { MemoryStore, type RecallResult } from '@artemis/memory';
import { HindsightMemoryStore } from '@artemis/memory/hindsight';
import type { Storage } from '@artemis/storage';
import { PostgresStorage } from '@artemis/storage/postgres';
import { FilesystemWorkspaceTransport } from '@artemis/workspace/filesystem';
import { createApp } from './api/app.ts';
import { createCallSessions } from './calls/call-sessions.ts';
import { type AgentServerConfig, loadConfig } from './config.ts';
import { createConversationService } from './conversations/service.ts';
import { ConversationEventHub } from './events/hub.ts';
import { createMemoryCoordinator } from './memory/coordinator.ts';
import { createMemoryTools } from './memory/tools.ts';
import { createModelRouter } from './models/routing.ts';
import { PromptRenderer } from './prompts/renderer.ts';
import { loadSubagentDefinitions } from './subagents/definitions.ts';
import { createTitleService } from './titles/title-service.ts';
import { createAgentRuntime } from './workers/runtime.ts';

const PROMPTS_DIR = fileURLToPath(new URL('../prompts', import.meta.url));
const LAST_ACTIVE_KEY = 'last_active_conversation_id';

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  const logger = consoleLogger('agent-server');
  const clock = systemClock;

  const storage = new PostgresStorage({ connectionString: config.databaseUrl });
  await storage.migrate();

  // Providers and routing: nothing else in the service knows vendor SDKs.
  const router = createModelRouter(config, createProviders(config));
  const prompts = new PromptRenderer(PROMPTS_DIR);
  const subagents = await loadSubagentDefinitions(join(PROMPTS_DIR, 'agents'));

  // Memory: Hindsight when configured; otherwise a store that recalls nothing and retains nowhere.
  const memoryStore: MemoryStore = config.memory.enabled
    ? new HindsightMemoryStore({
        baseUrl: config.memory.hindsightUrl,
        apiKey: config.memory.hindsightApiKey,
        bankId: config.memory.bankId,
      })
    : new DisabledMemoryStore();
  const memory = createMemoryCoordinator({
    store: memoryStore,
    storage,
    config,
    clock,
    logger: logger.child('memory'),
  });
  memory.start();
  memoryStore.ensureReady().catch((error: unknown) => {
    logger.warn('memory bank not ready', { message: errorMessage(error) });
  });

  const workspace = new FilesystemWorkspaceTransport({
    root: config.workspace.root,
    displayRoot: config.workspace.displayRoot,
    runAs: config.workspace.runAs,
    ripgrep: 'auto',
  });

  // MCP: manual servers in storage, device servers pushed by the gateway, catalog refreshed on change.
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
    present: config.assistant.presentTool ?? false,
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

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info('listening', { port: info.port });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    server.close();
    await supervisor.shutdown();
    const lastActive = await storage.appState.get<string>(LAST_ACTIVE_KEY).catch(() => null);
    if (lastActive) await memory.flush(lastActive, 'shutdown').catch(() => undefined);
    await memory.stop();
    await titles.stop();
    events.close();
    await storage.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

/** Memory disabled (no HINDSIGHT_URL): recalls nothing, retains nothing, never blocks a turn. */
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

function createProviders(config: AgentServerConfig): ProviderRegistry {
  const providers: LlmProvider[] = [new AnthropicLlmProvider({ apiKey: config.providers.anthropicApiKey })];
  if (config.providers.openAiCompatible) {
    providers.push(new OpenAiCompatibleLlmProvider(config.providers.openAiCompatible));
  }
  return new ProviderRegistry(providers);
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

/** MCP results (images, files) are saved under `data/artifacts/<conversation>/`, read-only for agents. */
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('main.ts')) {
  main().catch((error: unknown) => {
    console.error('[agent-server] fatal', error);
    process.exit(1);
  });
}
