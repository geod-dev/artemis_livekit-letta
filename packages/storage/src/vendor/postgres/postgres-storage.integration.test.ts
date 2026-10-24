import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { type StorageFixture, storageContract } from '../../../test/storage-contract.ts';
import { PostgresStorage } from './index.ts';
import { migrationChecksum } from './migrator.ts';
import { baseUrl, createTempDatabase, skip, TABLES, withTempDatabase } from './integration-setup.ts';

test('PostgresStorage migrations', { skip }, async (t) => {
  const server = baseUrl ?? '';

  await t.test('migrate applies the initial schema once and is idempotent', async () => {
    await withTempDatabase(server, async (url) => {
      const storage = new PostgresStorage({ connectionString: url });
      try {
        assert.deepEqual(await storage.migrate(), ['0001_initial', '0002_prompt_snapshot_owner_links']);
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
        assert.deepEqual([...first, ...second].sort(), ['0001_initial', '0002_prompt_snapshot_owner_links']);
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
        await assert.rejects(
          storage.migrate(),
          (error: unknown) => (error as { code?: string }).code === 'migration_changed'
        );
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
    const database = await createTempDatabase(baseUrl ?? '');
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
