import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TurnMode } from '../../chat-types';
import { config } from '../config';
import type { BackgroundUpdate } from '../conversations/messages.ts';

/** Application state which Letta does not persist for background tasks. */
export interface TaskOrigin {
  conversationId: string;
  taskId: string;
  workerConversationId?: string;
  kind?: 'agent' | 'command';
  title: string;
  mode: TurnMode;
  depth: number;
  stopped?: boolean;
  startedAt: string;
}

export type DeliveryState = 'held' | 'queued' | 'inflight' | 'delivered';

export interface UpdateRecord extends BackgroundUpdate {
  taskId?: string;
  kind?: 'agent' | 'command';
  conversationId: string;
  depth: number;
  delivery: DeliveryState;
  /** Present only while text or voice generation owns the update. */
  deliveryToken?: string;
  deliveryFrom?: 'held' | 'queued';
  unread: boolean;
  createdAt: string;
}

export interface BackgroundState {
  version: 3;
  origins: Record<string, TaskOrigin>;
  updates: Record<string, UpdateRecord>;
  seen: string[];
  /** Retired source conversations route late worker callbacks to a fork, or suppress them after archive. */
  retired: Record<string, { destinationConversationId: string | null; retiredAt: string }>;
}

const MAX_UPDATES = 300;
const MAX_SEEN = 1000;
const ORIGIN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
function stateFile(): string {
  return join(config.workspace.dataDir, 'background.json');
}
export interface BackgroundStoragePort {
  read(): string | null;
  writeAtomic(contents: string): Promise<void>;
}
let storage: BackgroundStoragePort = {
  read() {
    try {
      return readFileSync(stateFile(), 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  },
  async writeAtomic(contents) {
    const file = stateFile();
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, contents, { encoding: 'utf8' });
    await rename(temp, file);
  },
};
let loaded: BackgroundState | undefined;
let writeQueue: Promise<void> = Promise.resolve();

/** Await every durable state write queued before application shutdown. */
export async function flushBackgroundStorage(): Promise<void> {
  await writeQueue;
}

export class BackgroundStoreLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BackgroundStoreLoadError';
  }
}

function emptyState(): BackgroundState {
  return { version: 3, origins: {}, updates: {}, seen: [], retired: {} };
}

/** Read and migrate the existing unversioned schema without weakening validation. */
function load(): BackgroundState {
  const file = stateFile();
  let raw: string;
  try {
    const value = storage.read();
    if (value === null) return emptyState();
    raw = value;
  } catch (error) {
    throw new BackgroundStoreLoadError(`Cannot read background state at ${file}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BackgroundStoreLoadError(
      `Background state at ${file} is invalid JSON; file preserved`,
      { cause: error }
    );
  }
  try {
    return validateState(parsed);
  } catch (error) {
    throw new BackgroundStoreLoadError(
      `Background state at ${file} has an unsupported or invalid schema; file preserved`,
      { cause: error }
    );
  }
}

/** Configure storage before the first read; primarily used by server composition and isolated tests. */
export function configureBackgroundStorage(next: BackgroundStoragePort): void {
  if (loaded) throw new Error('Background storage must be configured before state is read');
  storage = next;
}

function validateState(value: unknown): BackgroundState {
  if (!isObject(value)) throw new Error('state must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2 && raw.version !== 3)
    throw new Error('unknown version');
  if (!isObject(raw.origins) || !isObject(raw.updates) || !Array.isArray(raw.seen))
    throw new Error('missing state fields');
  if (!raw.seen.every((v) => typeof v === 'string')) throw new Error('invalid seen list');
  const origins: Record<string, TaskOrigin> = {};
  for (const [key, item] of Object.entries(raw.origins)) {
    if (
      !isObject(item) ||
      typeof item.conversationId !== 'string' ||
      typeof item.taskId !== 'string' ||
      typeof item.title !== 'string' ||
      !['text', 'voice-short', 'voice-long'].includes(String(item.mode)) ||
      !Number.isInteger(item.depth) ||
      typeof item.startedAt !== 'string' ||
      (item.workerConversationId !== undefined && typeof item.workerConversationId !== 'string') ||
      (item.kind !== undefined && item.kind !== 'agent' && item.kind !== 'command') ||
      (item.stopped !== undefined && typeof item.stopped !== 'boolean')
    )
      throw new Error(`invalid origin ${key}`);
    origins[key] = item as unknown as TaskOrigin;
  }
  const updates: Record<string, UpdateRecord> = {};
  for (const [key, item] of Object.entries(raw.updates)) {
    if (
      !isObject(item) ||
      typeof item.id !== 'string' ||
      item.id !== key ||
      typeof item.conversationId !== 'string' ||
      typeof item.title !== 'string' ||
      !['completed', 'failed', 'cancelled'].includes(String(item.status)) ||
      typeof item.needsInput !== 'boolean' ||
      typeof item.report !== 'string' ||
      !Number.isInteger(item.depth) ||
      !['held', 'queued', 'inflight', 'delivered'].includes(String(item.delivery)) ||
      typeof item.unread !== 'boolean' ||
      typeof item.createdAt !== 'string' ||
      (item.durationMs !== undefined && (typeof item.durationMs !== 'number' || !Number.isFinite(item.durationMs) || item.durationMs < 0)) ||
      (item.taskId !== undefined && typeof item.taskId !== 'string') ||
      (item.kind !== undefined && item.kind !== 'agent' && item.kind !== 'command') ||
      (item.deliveryToken !== undefined && typeof item.deliveryToken !== 'string') ||
      (item.deliveryFrom !== undefined &&
        item.deliveryFrom !== 'held' &&
        item.deliveryFrom !== 'queued')
    ) {
      throw new Error(`invalid update ${key}`);
    }
    const update = structuredClone(item) as unknown as UpdateRecord;
    // A process restart leaves no live generator to finish an in-flight claim.
    if (update.delivery === 'inflight') {
      update.delivery = update.deliveryFrom ?? 'held';
      delete update.deliveryToken;
      delete update.deliveryFrom;
    }
    updates[key] = update;
  }
  // Version 1 was the original unversioned representation.
  const retired: BackgroundState['retired'] = {};
  if (raw.retired !== undefined) {
    if (!isObject(raw.retired)) throw new Error('invalid retired conversations');
    for (const [id, item] of Object.entries(raw.retired)) {
      if (
        !isObject(item) ||
        typeof item.retiredAt !== 'string' ||
        (item.destinationConversationId !== null &&
          typeof item.destinationConversationId !== 'string')
      ) {
        throw new Error(`invalid retired conversation ${id}`);
      }
      retired[id] = item as unknown as BackgroundState['retired'][string];
    }
  }
  return { version: 3, origins, updates, seen: (raw.seen as string[]).slice(-MAX_SEEN), retired };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function currentState(): BackgroundState {
  return (loaded ??= load());
}

/** Return a detached read snapshot; callers cannot mutate persisted state directly. */
export function snapshot(): BackgroundState {
  return structuredClone(currentState());
}

/** Serialize mutations and publish them to memory only after durable atomic persistence. */
export function transact<T>(mutator: (draft: BackgroundState) => T): Promise<T> {
  const operation = writeQueue.then(async () => {
    const draft = structuredClone(currentState());
    const result = mutator(draft);
    prune(draft);
    await persist(draft);
    loaded = draft;
    return result;
  });
  writeQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

function prune(s: BackgroundState): void {
  const now = Date.now();
  for (const [key, origin] of Object.entries(s.origins)) {
    const started = Date.parse(origin.startedAt);
    if (!Number.isFinite(started) || now - started > ORIGIN_MAX_AGE_MS) delete s.origins[key];
  }
  const updates = Object.values(s.updates).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const removable = updates.filter((u) => u.delivery === 'delivered' && !u.unread);
  const excess = Math.max(0, updates.length - MAX_UPDATES);
  for (const old of removable.slice(0, excess)) delete s.updates[old.id];
  s.seen = s.seen.slice(-MAX_SEEN);
}

async function persist(s: BackgroundState): Promise<void> {
  await storage.writeAtomic(JSON.stringify(s));
}

export function originKey(conversationId: string, taskId: string): string {
  return `${conversationId}|${taskId}`;
}
