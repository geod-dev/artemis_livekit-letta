import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TurnMode } from '../chat-types';
import { config } from './config';
import type { BackgroundUpdate } from './messages';

/**
 * Application state about background work that Letta does not keep: where a
 * task was started from, results held for the next turn, and which delivered
 * results the user has not read or heard yet. Letta's local backend has no
 * metadata field for this, so it is kept in one small JSON file in the
 * workspace's data folder. Letta still owns the workers and the transcript.
 */

/** The thread a background task was started from, captured when it starts. */
export interface TaskOrigin {
  conversationId: string;
  taskId: string;
  workerConversationId?: string;
  title: string;
  mode: TurnMode;
  /** 0 for work started by the user; +1 for work started while answering an update. */
  depth: number;
  /** Stopped on purpose (TaskStop): its failure is not a terminal failure. */
  stopped?: boolean;
  startedAt: string;
}

export interface UpdateRecord extends BackgroundUpdate {
  conversationId: string;
  depth: number;
  /**
   * held: waits for the conversation's next turn; queued: announced to the live
   * call; delivered: part of the conversation (spoken, written or injected).
   */
  delivery: 'held' | 'queued' | 'delivered';
  /** Not yet read in the chat or heard completely in a call. */
  unread: boolean;
  createdAt: string;
}

interface State {
  origins: Record<string, TaskOrigin>;
  updates: Record<string, UpdateRecord>;
  /** Notifications already handled, to drop duplicates. */
  seen: string[];
}

const MAX_UPDATES = 300;
const MAX_SEEN = 1000;

const file = join(config.workspace.dataDir, 'background.json');
let loaded: State | undefined;

function load(): State {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>;
    return {
      origins: parsed.origins ?? {},
      updates: parsed.updates ?? {},
      seen: parsed.seen ?? [],
    };
  } catch {
    return { origins: {}, updates: {}, seen: [] };
  }
}

export function state(): State {
  return (loaded ??= load());
}

/** Persist synchronously (small file, rare writes) via an atomic rename. */
export function save(): void {
  const s = state();
  const updates = Object.values(s.updates).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const old of updates.slice(0, Math.max(0, updates.length - MAX_UPDATES))) {
    delete s.updates[old.id];
  }
  s.seen = s.seen.slice(-MAX_SEEN);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(s));
  renameSync(`${file}.tmp`, file);
}

export function originKey(conversationId: string, taskId: string): string {
  return `${conversationId}|${taskId}`;
}
