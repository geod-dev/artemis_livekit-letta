import type { Clock } from '@artemis/core';
import type {
  AppStateKey,
  BackgroundUpdateRecord,
  ConversationRecord,
  McpSettingsRecord,
  MemoryRetentionRecord,
  MessageRecord,
  PromptSnapshotRecord,
  TaskRecord,
  ToolCallRecord,
  TurnRecord,
} from '../domain.ts';

/** One map per table, keyed by primary key (conversation_recalls: conversation -> memory -> turn). */
export interface MemoryState {
  conversations: Map<string, ConversationRecord>;
  promptSnapshots: Map<string, PromptSnapshotRecord>;
  turns: Map<string, TurnRecord>;
  messages: Map<string, MessageRecord>;
  toolCalls: Map<string, ToolCallRecord>;
  tasks: Map<string, TaskRecord>;
  updates: Map<string, BackgroundUpdateRecord>;
  mcpSettings: McpSettingsRecord | null;
  appState: Map<AppStateKey, unknown>;
  memoryRetentions: Map<string, MemoryRetentionRecord>;
  recalls: Map<string, Map<string, string | null>>;
}

export function emptyMemoryState(): MemoryState {
  return {
    conversations: new Map(),
    promptSnapshots: new Map(),
    turns: new Map(),
    messages: new Map(),
    toolCalls: new Map(),
    tasks: new Map(),
    updates: new Map(),
    mcpSettings: null,
    appState: new Map(),
    memoryRetentions: new Map(),
    recalls: new Map(),
  };
}

const settled = (): undefined => undefined;

/**
 * Holds the state of an {@link InMemoryStorage}. Operations are serialized: a transaction holds the queue
 * for its whole duration, so no outside operation observes its partial writes. A transaction that throws
 * restores the state it started from (all-or-nothing, like Postgres).
 */
export class MemoryDatabase {
  state: MemoryState = emptyMemoryState();
  private tail: Promise<void> = Promise.resolve();

  locked<T>(body: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(body);
    this.tail = result.then(settled, settled);
    return result;
  }

  transaction<T>(body: () => Promise<T>): Promise<T> {
    return this.locked(async () => {
      const backup = structuredClone(this.state);
      try {
        return await body();
      } catch (error) {
        this.state = backup;
        throw error;
      }
    });
  }
}

/**
 * How repositories reach the state. Outside a transaction every call is queued behind running transactions;
 * inside one the transaction already holds the queue. Results are detached copies, so callers cannot
 * mutate stored records. Repository bodies validate before they write, because a root call is not rolled
 * back on error.
 */
export class MemoryAccess {
  constructor(
    readonly db: MemoryDatabase,
    readonly clock: Clock,
    readonly transactional: boolean
  ) {}

  now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  run<T>(body: (state: MemoryState) => T): Promise<T> {
    const work = () => structuredClone(body(this.db.state));
    return this.transactional ? Promise.resolve().then(work) : this.db.locked(work);
  }
}
