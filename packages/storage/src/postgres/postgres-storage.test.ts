import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { type StorageFixture, storageContract } from '../contract/storage-contract.ts';
import { PostgresStorage } from './index.ts';
import { migrationChecksum } from './migrator.ts';

/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set, e.g. postgres://user:pass@localhost:5432/postgres.
 * Every suite creates its own database from that server and drops it afterwards.
 */
const baseUrl = process.env.TEST_DATABASE_URL;
const skip = baseUrl === undefined ? 'set TEST_DATABASE_URL to run Postgres tests' : false;

const TABLES = [
  'conversation_recalls', 'memory_retentions', 'app_state', 'mcp_settings', 'background_updates', 'tool_calls',
  'messages', 'tasks', 'turns', 'prompt_snapshots', 'conversations',
];

interface TempDatabase {
  url: string;
  drop(): Promise<void>;
}

async function createTempDatabase(serverUrl: string): Promise<TempDatabase> {
  const name = `artemis_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: serverUrl });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const cleanup = new Pool({ connectionString: serverUrl });
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

async function withTempDatabase(serverUrl: string, run: (url: string) => Promise<void>): Promise<void> {
  const database = await createTempDatabase(serverUrl);
  try {
    await run(database.url);
  } finally {
    await database.drop();
  }
}

test('PostgresStorage migrations', { skip }, async (t) => {
  const server = baseUrl ?? '';

  await t.test('migrate applies the initial schema once and is idempotent', async () => {
    await withTempDatabase(server, async (url) => {
      const storage = new PostgresStorage({ connectionString: url });
      try {
        assert.deepEqual(await storage.migrate(), ['0001_initial']);
        assert.deepEqual(await storage.migrate(), []);
        assert.equal(await storage.healthy(), true);
      } finally {
        await storage.close();
      }
    });
  });

  await t.test('concurrent migrators apply each file exactly once', async () => {
    await withTempDatabase(server, async (url) => {
      const a = new PostgresStorage({ connectionString: url });
      const b = new PostgresStorage({ connectionString: url });
      try {
        const [first, second] = await Promise.all([a.migrate(), b.migrate()]);
        assert.deepEqual([...first, ...second], ['0001_initial']);
      } finally {
        await a.close();
        await b.close();
      }
    });
  });

  await t.test('a migration whose file changed after it was applied is refused', async () => {
    await withTempDatabase(server, async (url) => {
      const storage = new PostgresStorage({ connectionString: url });
      const direct = new Pool({ connectionString: url });
      try {
        await storage.migrate();
        await direct.query('UPDATE schema_migrations SET checksum = $1', [migrationChecksum('edited')]);
        await assert.rejects(storage.migrate(), (error: unknown) => (error as { code?: string }).code === 'migration_changed');
      } finally {
        await direct.end();
        await storage.close();
      }
    });
  });
});

if (baseUrl === undefined) {
  test('PostgresStorage contract', { skip }, () => {});
} else {
  storageContract('PostgresStorage', async (): Promise<StorageFixture> => {
    const database = await createTempDatabase(baseUrl);
    const storage = new PostgresStorage({ connectionString: database.url });
    await storage.migrate();
    const direct = new Pool({ connectionString: database.url });
    return {
      fresh: async () => {
        await direct.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);
        return storage;
      },
      dispose: async () => {
        await storage.close();
        await direct.end();
        await database.drop();
      },
    };
  });
}
