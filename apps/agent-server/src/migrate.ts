/** `pnpm --filter @artemis/agent-server migrate`: apply storage migrations and exit. main.ts runs the same function at startup. */
import { consoleLogger, errorMessage } from '@artemis/core';
import { openStorage } from './compose.ts';
import { type AgentServerConfig, loadConfig, loadRootEnv } from './config.ts';
import { runAsEntry } from './entry.ts';

export async function migrate(config: AgentServerConfig = loadConfig(process.env)): Promise<string[]> {
  const logger = consoleLogger('migrate');
  const storage = openStorage(config);
  try {
    const applied = await storage.migrate();
    logger.info(applied.length ? 'migrations applied' : 'database is up to date', { applied });
    return applied;
  } finally {
    await storage.close();
  }
}

runAsEntry(
  import.meta.url,
  () => {
    loadRootEnv();
    return migrate();
  },
  (error) => {
    consoleLogger('migrate').error('migration failed', { error: errorMessage(error) });
    process.exit(1);
  }
);
