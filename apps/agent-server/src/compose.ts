/**
 * Composition root: the only app module that imports vendor implementations
 * (`@artemis/llm/anthropic`, `@artemis/llm/openai-compatible`,
 * `@artemis/storage/postgres`, `@artemis/memory/hindsight`,
 * `@artemis/workspace/filesystem`, `@artemis/mcp/sdk`). Three steps, each with one job:
 *
 * - `compose(config)` makes every vendor-or-no-op choice and returns the port set.
 * - `buildServices(ports, ...)` builds the whole service graph over those ports. It is the only
 *   place the graph is constructed; `buildApp` and the test harnesses both use it.
 * - `buildApp(config)` runs the boot sequence (memory, MCP registry, recovery, workers) and
 *   returns the Hono app with a `close()` that shuts everything down in order.
 *
 * `main.ts` only adds the process lifecycle (signals, serving, exit); every other module
 * receives its collaborators by parameter.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Clock, consoleLogger, errorMessage, type Logger, systemClock } from '@artemis/core';
import { type LlmProvider, ProviderRegistry } from '@artemis/llm';
import { AnthropicLlmProvider } from '@artemis/llm/anthropic';
import { OpenAiCompatibleLlmProvider } from '@artemis/llm/openai-compatible';
import type { MemoryStore } from '@artemis/memory';
import { HindsightMemoryStore } from '@artemis/memory/hindsight';
import { McpCatalog, McpServerRegistry, type McpSettingsStore, mcpRevision } from '@artemis/mcp';
import { SdkMcpClient } from '@artemis/mcp/sdk';
import type { Storage } from '@artemis/storage';
import { PostgresStorage } from '@artemis/storage/postgres';
import type { WorkspaceTransport } from '@artemis/workspace';
import { FilesystemWorkspaceTransport } from '@artemis/workspace/filesystem';
import type { Hono } from 'hono';
import { createApp } from './api/app.ts';
import { workspaceArtifactSink } from './tools/artifact-sink.ts';
import { createCallSessions, type CallSessions } from './calls/call-sessions.ts';
import { createVoiceService, type VoiceService } from './calls/voice-service.ts';
import { type AgentServerConfig, WORKSPACE_RIPGREP } from './config.ts';
import { createConversationService, type ConversationService } from './conversations/service.ts';
import { ConversationEventHub } from './events/hub.ts';
import { createMemoryCoordinator, LAST_ACTIVE_CONVERSATION_KEY, type MemoryCoordinator } from './memory/coordinator.ts';
import { NoopMemoryStore } from './memory/noop-memory-store.ts';
import { createModelRouter, type ModelRouter } from './models/routing.ts';
import { PromptRenderer } from './prompts/renderer.ts';
import { loadSubagentDefinitions } from './subagents/definitions.ts';
import { createTitleService, type TitleService } from './titles/title-service.ts';
import { createMemoryTools } from './tools/memory-tools.ts';
import { type AgentRuntime, createAgentRuntime } from './workers/wiring.ts';

const PROMPTS_DIR = fileURLToPath(new URL('../templates', import.meta.url));

/** Every implementation the service runs on; the service graph receives these, never a vendor type. */
export interface ComposedPorts {
  storage: Storage;
  router: ModelRouter;
  memoryStore: MemoryStore;
  workspace: WorkspaceTransport;
  mcpClient: SdkMcpClient;
  catalog: McpCatalog;
  registry: McpServerRegistry;
}

export interface ComposeOptions {
  /** Overrides the Anthropic API base URL (the integration tests point it at a closed port). */
  anthropicBaseUrl?: string;
}

/** A storage handle only: what `migrate` needs. `compose` uses the same factory. */
export function openStorage(config: AgentServerConfig): Storage {
  return new PostgresStorage({ connectionString: config.databaseUrl });
}

export function compose(config: AgentServerConfig, options: ComposeOptions = {}): ComposedPorts {
  const storage = openStorage(config);
  const router = createModelRouter(config, createProviders(config, options));

  // Memory: Hindsight when configured; otherwise a store that recalls nothing and retains nowhere.
  const memoryStore: MemoryStore = config.memory.enabled
    ? new HindsightMemoryStore({
        baseUrl: config.memory.hindsightUrl,
        apiKey: config.memory.hindsightApiKey,
        bankId: config.memory.bankId,
      })
    : new NoopMemoryStore();

  const workspace = new FilesystemWorkspaceTransport({
    root: config.workspace.root,
    displayRoot: config.workspace.displayRoot,
    runAs: config.workspace.runAs,
    ripgrep: WORKSPACE_RIPGREP,
  });

  // MCP: manual servers in storage, device servers pushed by the gateway, catalog refreshed on change.
  const mcpClient = new SdkMcpClient({
    artifacts: workspaceArtifactSink(workspace),
    stdio: { cwd: config.workspace.root },
  });
  const { catalog, registry } = wireMcp(storage, mcpClient);

  return { storage, router, memoryStore, workspace, mcpClient, catalog, registry };
}

function createProviders(config: AgentServerConfig, options: ComposeOptions): ProviderRegistry {
  const providers: LlmProvider[] = [
    new AnthropicLlmProvider({
      apiKey: config.providers.anthropicApiKey,
      ...(options.anthropicBaseUrl ? { baseUrl: options.anthropicBaseUrl } : {}),
    }),
  ];
  if (config.providers.openAiCompatible) {
    providers.push(new OpenAiCompatibleLlmProvider(config.providers.openAiCompatible));
  }
  return new ProviderRegistry(providers);
}

/**
 * The registry pushes changes to the catalog, and the catalog reads the server list from the
 * registry. The registry is built first; its callbacks reach the catalog through `link`, which is
 * filled once the catalog exists, so no closure reads a variable declared after it.
 */
function wireMcp(storage: Storage, client: SdkMcpClient): { catalog: McpCatalog; registry: McpServerRegistry } {
  const link: { catalog?: McpCatalog } = {};
  const linkedCatalog = (): McpCatalog => {
    if (!link.catalog) throw new Error('MCP catalog is not wired');
    return link.catalog;
  };
  const registry = new McpServerRegistry(
    mcpSettingsStore(storage),
    () => linkedCatalog().refresh().then(() => undefined),
    () => linkedCatalog().status()
  );
  const catalog = new McpCatalog(client, () => registry.servers());
  link.catalog = catalog;
  return { catalog, registry };
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

/** The service graph: every service the HTTP app and the workers use, built over the ports. */
export interface Services {
  prompts: PromptRenderer;
  memory: MemoryCoordinator;
  events: ConversationEventHub;
  titles: TitleService;
  calls: CallSessions;
  runtime: AgentRuntime;
  conversations: ConversationService;
  voice: VoiceService;
}

/** Builds the whole service graph. The only construction site: no caller wires services itself. */
export async function buildServices(
  ports: ComposedPorts,
  config: AgentServerConfig,
  clock: Clock,
  logger: Logger
): Promise<Services> {
  const { storage, router, memoryStore, workspace, mcpClient, catalog } = ports;

  const prompts = new PromptRenderer(PROMPTS_DIR);
  const subagents = await loadSubagentDefinitions(join(PROMPTS_DIR, 'agents'));
  const memory = createMemoryCoordinator({ store: memoryStore, storage, config, clock, logger: logger.child('memory') });
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
    memoryTools: createMemoryTools({ store: memoryStore, coordinator: memory, config, clock, logger: logger.child('memory-tools') }),
    present: config.assistant.presentTool,
    clock,
    logger: logger.child('agent'),
  });
  calls.onEnded((conversationId, pending) => {
    void runtime.delivery.callEnded(conversationId, pending);
  });

  const conversations = createConversationService({
    storage,
    prompts,
    router,
    events,
    config,
    supervisor: runtime.supervisor,
    toolDefinitions: () => runtime.tools.definitions(),
    pendingRows: (conversationId) => runtime.delivery.eventRows(conversationId),
    onArchived: (conversationId) => runtime.supervisor.stopConversation(conversationId),
  });
  const voice = createVoiceService({ conversations, calls, delivery: runtime.delivery });

  return { prompts, memory, events, titles, calls, runtime, conversations, voice };
}

export interface BuiltApp {
  app: Hono;
  services: Services;
  /** Loads the MCP catalog. `main` calls it after serving starts; the tests await it. */
  refreshCatalog(): Promise<void>;
  /** Shutdown in order: workers (tasks end `failed: interrupted`), last-active memory flush, then storage. */
  close(): Promise<void>;
}

export interface BuildAppOptions extends ComposeOptions {
  logger?: Logger;
}

/**
 * The boot sequence after migrations: compose, build the graph, start memory, load the MCP
 * registry, recover after a restart, start the workers, and build the HTTP app. Memory is
 * non-blocking: its readiness check runs in the background.
 */
export async function buildApp(config: AgentServerConfig, options: BuildAppOptions = {}): Promise<BuiltApp> {
  const logger = options.logger ?? consoleLogger('agent-server');
  const clock = systemClock;
  const ports = compose(config, options);
  const { storage, memoryStore, catalog, registry } = ports;
  const services = await buildServices(ports, config, clock, logger);
  const { calls, events, memory, titles, runtime } = services;

  memory.start();
  memoryStore.ensureReady().catch((error: unknown) => {
    logger.warn('memory bank not ready', { message: errorMessage(error) });
  });
  await registry.load();
  await runtime.supervisor.recover();
  runtime.supervisor.start();

  const app = createApp({
    config,
    conversations: services.conversations,
    tasks: runtime.tasks,
    delivery: runtime.delivery,
    calls,
    voice: services.voice,
    events,
    mcp: registry,
    clock,
    logger,
    ready: async () => ({
      storage: await storage.healthy(),
      mcp: catalog.status().refreshedAt !== null,
      memory: await memoryStore.healthy(),
    }),
  });

  return {
    app,
    services,
    refreshCatalog: async () => {
      await catalog.refresh();
    },
    close: async () => {
      await runtime.supervisor.shutdown();
      const lastActive = await storage.appState.get<string>(LAST_ACTIVE_CONVERSATION_KEY).catch(() => null);
      if (lastActive) await memory.flush(lastActive, 'shutdown').catch(() => undefined);
      await memory.stop();
      await titles.stop();
      events.close();
      await storage.close();
    },
  };
}
