import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '@artemis/core';

export interface MigrationFile {
  /** File name without extension, e.g. `0001_initial`. Order = lexical. */
  id: string;
  sql: string;
}

export type MigrationQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/** Session-level advisory lock key that serializes migrators across processes. */
const MIGRATION_LOCK_KEY = 726_431_001;

/** Reads `NNNN_name.sql` files from `dir`, in name order. */
export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => /^\d{4}_[\w-]+\.sql$/.test(name)).sort();
  return Promise.all(
    names.map(async (name) => ({ id: name.slice(0, -'.sql'.length), sql: await readFile(join(dir, name), 'utf8') }))
  );
}

/** Line endings are normalized so a Windows checkout of the same file keeps its checksum. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Minimal forward-only SQL migrator (no extra dependency). `query` must be bound to one connection: the
 * advisory lock is session-scoped. Each file runs in its own transaction and is recorded in
 * `schema_migrations` with its checksum; a file changed after it was applied is an error.
 */
export class Migrator {
  constructor(
    readonly query: MigrationQuery,
    readonly files: () => Promise<MigrationFile[]>
  ) {}

  /** Returns the ids applied by this run. */
  async run(): Promise<string[]> {
    await this.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      return await this.apply();
    } finally {
      await this.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  }

  private async apply(): Promise<string[]> {
    await this.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id          text PRIMARY KEY,
         checksum    text NOT NULL,
         applied_at  timestamptz NOT NULL DEFAULT now()
       )`
    );
    const { rows } = await this.query('SELECT id, checksum FROM schema_migrations');
    const applied = new Map(rows.map((row) => {
      const { id, checksum } = row as { id: string; checksum: string };
      return [id, checksum] as const;
    }));

    const ran: string[] = [];
    const files = [...(await this.files())].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const file of files) {
      const checksum = migrationChecksum(file.sql);
      const known = applied.get(file.id);
      if (known !== undefined) {
        if (known !== checksum) {
          throw new AppError('migration_changed', `migration ${file.id} changed after it was applied`, 500);
        }
        continue;
      }
      await this.applyOne(file, checksum);
      ran.push(file.id);
    }
    return ran;
  }

  private async applyOne(file: MigrationFile, checksum: string): Promise<void> {
    await this.query('BEGIN');
    try {
      await this.query(file.sql);
      await this.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [file.id, checksum]);
      await this.query('COMMIT');
    } catch (error) {
      await this.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}
