import { fileURLToPath } from 'node:url';
import { consoleLogger } from '@artemis/core';
import { Pool } from 'pg';
import {
  type AppStateRepository,
  type BackgroundUpdateRepository,
  type ConversationRepository,
  type McpSettingsRepository,
  type MemoryRetentionRepository,
  type MessageRepository,
  type PromptSnapshotRepository,
  type RecallLedgerRepository,
  type Repositories,
  Storage,
  type TaskRepository,
  type ToolCallRepository,
  type TurnRepository,
} from '../repositories.ts';
import { PgRepositories } from './repositories.ts';
import { PgSession } from './session.ts';
import { Migrator, type MigrationFile, readMigrationFiles } from './migrator.ts';

export { Migrator, type MigrationFile, readMigrationFiles, migrationChecksum } from './migrator.ts';

export interface PostgresStorageOptions {
  /** `postgresql://artemis:...@postgres:5432/artemis` */
  connectionString: string;
  poolSize?: number;
  /** Directory of `NNNN_name.sql` files (default: packages/storage/migrations). */
  migrationsDir?: string;
}

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** `pg` (node-postgres) Pool-backed storage. Repositories are thin SQL mappers (snake_case <-> camelCase). */
export class PostgresStorage extends Storage {
  private readonly pool: Pool;
  private readonly session: PgSession;
  private readonly root: PgRepositories;
  private readonly migrationsDir: string;

  constructor(readonly options: PostgresStorageOptions) {
    super();
    this.pool = new Pool({ connectionString: options.connectionString, max: options.poolSize ?? 10 });
    // An idle client can fail (e.g. server restart); the pool discards it, so log instead of crashing.
    this.pool.on('error', (error) => consoleLogger('postgres').error('idle client error', { message: error.message }));
    this.session = new PgSession(this.pool, null);
    this.root = new PgRepositories(this.session);
    this.migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  }

  get conversations(): ConversationRepository {
    return this.root.conversations;
  }
  get promptSnapshots(): PromptSnapshotRepository {
    return this.root.promptSnapshots;
  }
  get turns(): TurnRepository {
    return this.root.turns;
  }
  get messages(): MessageRepository {
    return this.root.messages;
  }
  get toolCalls(): ToolCallRepository {
    return this.root.toolCalls;
  }
  get tasks(): TaskRepository {
    return this.root.tasks;
  }
  get updates(): BackgroundUpdateRepository {
    return this.root.updates;
  }
  get mcpSettings(): McpSettingsRepository {
    return this.root.mcpSettings;
  }
  get appState(): AppStateRepository {
    return this.root.appState;
  }
  get memoryRetentions(): MemoryRetentionRepository {
    return this.root.memoryRetentions;
  }
  get recallLedger(): RecallLedgerRepository {
    return this.root.recallLedger;
  }

  transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T> {
    return this.session.transaction((tx) => fn(new PgRepositories(tx)));
  }

  /** Applies pending migrations on one dedicated connection (the advisory lock is per session). */
  async migrate(): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      const migrator = new Migrator(
        (sql, params) => client.query(sql, params),
        () => readMigrationFiles(this.migrationsDir)
      );
      return await migrator.run();
    } finally {
      client.release();
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.session.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
