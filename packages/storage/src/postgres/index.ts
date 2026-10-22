import { notImplemented } from '@artemis/core';
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

export { Migrator, type MigrationFile } from './migrator.ts';

export interface PostgresStorageOptions {
  /** `postgresql://artemis:...@postgres:5432/artemis` */
  connectionString: string;
  poolSize?: number;
  /** Directory of `NNNN_name.sql` files (default: packages/storage/migrations). */
  migrationsDir?: string;
}

/** `pg` (node-postgres) Pool-backed storage. Repositories are thin SQL mappers (snake_case <-> camelCase). */
export class PostgresStorage extends Storage {
  constructor(readonly options: PostgresStorageOptions) {
    super();
  }

  get conversations(): ConversationRepository {
    return notImplemented('PostgresStorage.conversations');
  }
  get promptSnapshots(): PromptSnapshotRepository {
    return notImplemented('PostgresStorage.promptSnapshots');
  }
  get turns(): TurnRepository {
    return notImplemented('PostgresStorage.turns');
  }
  get messages(): MessageRepository {
    return notImplemented('PostgresStorage.messages');
  }
  get toolCalls(): ToolCallRepository {
    return notImplemented('PostgresStorage.toolCalls');
  }
  get tasks(): TaskRepository {
    return notImplemented('PostgresStorage.tasks');
  }
  get updates(): BackgroundUpdateRepository {
    return notImplemented('PostgresStorage.updates');
  }
  get mcpSettings(): McpSettingsRepository {
    return notImplemented('PostgresStorage.mcpSettings');
  }
  get appState(): AppStateRepository {
    return notImplemented('PostgresStorage.appState');
  }
  get memoryRetentions(): MemoryRetentionRepository {
    return notImplemented('PostgresStorage.memoryRetentions');
  }
  get recallLedger(): RecallLedgerRepository {
    return notImplemented('PostgresStorage.recallLedger');
  }

  transaction<T>(_fn: (tx: Repositories) => Promise<T>): Promise<T> {
    return notImplemented('PostgresStorage.transaction');
  }
  migrate(): Promise<string[]> {
    return notImplemented('PostgresStorage.migrate');
  }
  healthy(): Promise<boolean> {
    return notImplemented('PostgresStorage.healthy');
  }
  close(): Promise<void> {
    return notImplemented('PostgresStorage.close');
  }
}
