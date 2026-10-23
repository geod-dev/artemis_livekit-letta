/** `pnpm --filter @artemis/agent-server migrate`: apply storage migrations and exit. main.ts runs the same function at startup. */
import { pathToFileURL } from 'node:url';
import { consoleLogger, errorMessage } from '@artemis/core';
import { compose } from './compose.ts';
import { type AgentServerConfig, loadConfig, loadRootEnv } from './config.ts';

export async function migrate(config: AgentServerConfig = loadConfig(process.env)): Promise<string[]> {
  const logger = consoleLogger('migrate');
  const { storage } = compose(config);
  try {
    const applied = await storage.migrate();
    logger.info(applied.length ? 'migrations applied' : 'database is up to date', { applied });
    return applied;
  } finally {
    await storage.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadRootEnv();
  migrate().catch((error: unknown) => {
    consoleLogger('migrate').error('migration failed', { error: errorMessage(error) });
    process.exit(1);
  });
}
