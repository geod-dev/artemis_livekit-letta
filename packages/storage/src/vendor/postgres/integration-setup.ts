import { createTestDatabase, dropTestDatabase } from './testing.ts';

/**
 * Shared gate and database setup for the Postgres integration suites (*.integration.test.ts).
 * Runs against a real Postgres when TEST_DATABASE_URL is set, e.g. postgres://user:pass@localhost:5432/postgres.
 * TEST_DATABASE_URL is a server-level admin URL, not a database the tests reuse: every suite creates its own
 * database on that server and drops it afterwards.
 */
export const baseUrl = process.env.TEST_DATABASE_URL;
export const skip = baseUrl === undefined ? 'set TEST_DATABASE_URL to run Postgres tests' : false;

/** Every table the application writes, in the order a TRUNCATE needs them listed. */
export const TABLES = [
  'conversation_recalls',
  'memory_retentions',
  'app_state',
  'mcp_settings',
  'background_updates',
  'tool_calls',
  'messages',
  'tasks',
  'turns',
  'prompt_snapshots',
  'conversations',
];

export interface TempDatabase {
  url: string;
  drop(): Promise<void>;
}

export async function createTempDatabase(serverUrl: string): Promise<TempDatabase> {
  const database = await createTestDatabase(serverUrl);
  return { url: database.url, drop: () => dropTestDatabase(serverUrl, database.name) };
}

export async function withTempDatabase(serverUrl: string, run: (url: string) => Promise<void>): Promise<void> {
  const database = await createTempDatabase(serverUrl);
  try {
    await run(database.url);
  } finally {
    await database.drop();
  }
}
