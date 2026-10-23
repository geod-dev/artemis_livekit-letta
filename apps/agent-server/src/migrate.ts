/** `pnpm --filter @artemis/agent-server migrate`: apply storage migrations and exit. */
import { consoleLogger } from '@artemis/core';
import { PostgresStorage } from '@artemis/storage/postgres';
import { loadConfig } from './config.ts';

export async function migrate(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const logger = consoleLogger('migrate');
  const config = loadConfig(env);
  const storage = new PostgresStorage({ connectionString: config.databaseUrl });
  try {
    const applied = await storage.migrate();
    logger.info(applied.length ? 'migrations applied' : 'database is up to date', { applied });
    return applied;
  } finally {
    await storage.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts')) {
  migrate().catch((error: unknown) => {
    console.error('[migrate] failed', error);
    process.exit(1);
  });
}
