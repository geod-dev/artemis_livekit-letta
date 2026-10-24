/**
 * Boot (the graph is built in `compose.ts`): loadConfig -> assertAnthropicKeyForModels ->
 * migrate -> buildApp (memory, MCP registry, recovery, workers) -> serve (Hono on
 * AGENT_SERVER_PORT) -> MCP catalog refresh. /ready reports mcp=false until that first refresh
 * completes. Memory is non-blocking: its bank check runs in the background.
 * SIGTERM/SIGINT: stop accepting, then `buildApp`'s close (running tasks end `cancelled`,
 * the last active conversation's memory is flushed, storage closes). A failed shutdown step
 * is logged and the process exits with code 1.
 */
import { serve } from '@hono/node-server';
import { consoleLogger, errorMessage } from '@artemis/core';
import { buildApp } from './compose.ts';
import { assertAnthropicKeyForModels, loadConfig, loadRootEnv } from './config.ts';
import { runAsEntry } from './entry.ts';
import { migrate } from './migrate.ts';

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  assertAnthropicKeyForModels(config);
  const logger = consoleLogger('agent-server', { level: config.logLevel });

  await migrate(config);
  const booted = await buildApp(config, { logger });

  const server = serve({ fetch: booted.app.fetch, port: config.port }, (info) => {
    logger.info('listening', { port: info.port });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    server.close();
    try {
      await booted.close();
      process.exit(0);
    } catch (error) {
      logger.error('shutdown failed', { signal, error: errorMessage(error) });
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  // Serving starts before the MCP refresh, which can take up to the SDK deadline per server.
  await booted.refreshCatalog();
}

runAsEntry(
  import.meta.url,
  () => {
    loadRootEnv();
    return main();
  },
  (error) => {
    consoleLogger('agent-server').error('fatal', { error: errorMessage(error) });
    process.exit(1);
  }
);
