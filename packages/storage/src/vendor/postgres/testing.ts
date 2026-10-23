// Test-only helpers (`@artemis/storage/postgres/testing`). `adminUrl` is a server-level Postgres URL.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export interface TestDatabase {
  name: string;
  url: string;
}

/** Creates `artemis_test_<random>` on the server behind `adminUrl` and returns its name and URL. */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `artemis_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

/** Drops a database made by `createTestDatabase`, disconnecting any sessions still open on it. */
export async function dropTestDatabase(adminUrl: string, name: string): Promise<void> {
  if (!/^artemis_test_[0-9a-f]{32}$/.test(name)) throw new Error(`refusing to drop non-test database "${name}"`);
  const admin = new Pool({ connectionString: adminUrl });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
