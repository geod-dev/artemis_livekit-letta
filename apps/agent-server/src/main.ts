/**
 * Boot (vendor implementations are selected in `compose.ts`): loadConfig ->
 * migrate -> compose -> memory coordinator start -> MCP registry load ->
 * supervisor.recover -> supervisor start -> serve (Hono on AGENT_SERVER_PORT) ->
 * MCP catalog refresh. /ready reports mcp=false until that first refresh completes.
 * Memory is non-blocking: its bank check runs in the background.
 * SIGTERM: stop accepting, stop workers (tasks end `failed: interrupted`), flush
 * the last active conversation's memory, stop the outbox, close storage.
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { consoleLogger, errorMessage, systemClock } from '@artemis/core';
import { createApp } from './api/app.ts';
import { createCallSessions } from './calls/call-sessions.ts';
import { compose } from './compose.ts';
import { type AgentServerConfig, loadConfig, loadRootEnv } from './config.ts';
import { createConversationService } from './conversations/service.ts';
import { ConversationEventHub } from './events/hub.ts';
import { createMemoryCoordinator } from './memory/coordinator.ts';
import { createMemoryTools } from './memory/tools.ts';
import { migrate } from './migrate.ts';
import { PromptRenderer } from './prompts/renderer.ts';
import { loadSubagentDefinitions } from './subagents/definitions.ts';
import { createTitleService } from './titles/title-service.ts';
import { createAgentRuntime } from './workers/runtime.ts';

const PROMPTS_DIR = fileURLToPath(new URL('../templates', import.meta.url));
const LAST_ACTIVE_KEY = 'last_active_conversation_id';

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config: AgentServerConfig = loadConfig(env);
  const logger = consoleLogger('agent-server');
  const clock = systemClock;

  await migrate(config);
  const { storage, router, memoryStore, workspace, mcpClient, catalog, registry } = compose(config);

  const prompts = new PromptRenderer(PROMPTS_DIR);
  const subagents = await loadSubagentDefinitions(join(PROMPTS_DIR, 'agents'));

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

  await registry.load();

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
    present: config.assistant.presentTool,
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
    supervisor,
    toolDefinitions: () => tools.definitions(),
    pendingRows: (conversationId) => delivery.eventRows(conversationId),
    onArchived: (conversationId) => supervisor.stopConversation(conversationId),
  });

  await supervisor.recover();
  supervisor.start();

  const app = createApp({
    config,
    conversations,
    tasks: runtime.tasks,
    delivery,
    calls,
    events,
    mcp: registry,
    clock,
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

  // Serving starts before the MCP refresh, which can take up to the SDK deadline per server.
  await catalog.refresh();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadRootEnv();
  main().catch((error: unknown) => {
    consoleLogger('agent-server').error('fatal', { error: errorMessage(error) });
    process.exit(1);
  });
}
