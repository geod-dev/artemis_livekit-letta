import { notImplemented } from '@artemis/core';

export interface MigrationFile {
  /** File name without extension, e.g. `0001_initial`. Order = lexical. */
  id: string;
  sql: string;
}

/**
 * Minimal forward-only SQL migrator (no extra dependency):
 * `pg_advisory_lock` -> ensure `schema_migrations(id text primary key, applied_at timestamptz)`
 * -> apply each unapplied file in its own transaction -> unlock.
 * A changed already-applied file is an error (checksum column).
 */
export class Migrator {
  constructor(
    readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
    readonly files: () => Promise<MigrationFile[]>
  ) {}

  /** Returns the ids applied by this run. */
  run(): Promise<string[]> {
    return notImplemented('Migrator.run');
  }
}
