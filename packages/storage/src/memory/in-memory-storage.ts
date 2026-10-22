import { type Clock, systemClock } from '@artemis/core';
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
import { MemoryAccess, MemoryDatabase } from './database.ts';
import { MemoryRepositories } from './repositories.ts';

export interface InMemoryStorageOptions {
  /** Time source for `created_at`-style columns (default: system clock). */
  clock?: Clock;
}

/**
 * Non-durable `Storage` with the same semantics as `PostgresStorage`: the same repository contracts, seq
 * allocation, soft deletes, optimistic MCP revisions and all-or-nothing transactions. Use it for tests of
 * code that depends on storage. The schema is implicit, so `migrate()` applies nothing.
 *
 * Do not call the root repositories from inside a `transaction` callback: they queue behind it and would
 * deadlock. Use the `tx` argument instead.
 */
export class InMemoryStorage extends Storage {
  private readonly db = new MemoryDatabase();
  private readonly clock: Clock;
  private readonly root: MemoryRepositories;

  constructor(options: InMemoryStorageOptions = {}) {
    super();
    this.clock = options.clock ?? systemClock;
    this.root = new MemoryRepositories(new MemoryAccess(this.db, this.clock, false));
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
    return this.db.transaction(() => fn(new MemoryRepositories(new MemoryAccess(this.db, this.clock, true))));
  }

  async migrate(): Promise<string[]> {
    return [];
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}
