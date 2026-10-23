import type { WorkspaceTransport } from '@artemis/workspace';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ATTACHMENT_PATH, ATTACHMENT_RETENTION_FILE } from './attachment-policy';

/**
 * Owners (conversations) of the uploads in `data/attachments`. An upload stays
 * while a conversation references it; unreferenced uploads are removed when the
 * user discards them, or once they have been abandoned for a day. Files the
 * agent writes are outside this registry.
 *
 * The state is gateway state: it lives in the gateway's data directory, never in
 * the workspace, so the agent cannot change it.
 */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;

type RetentionRecord = { createdAt: number; owners: string[]; mimeType?: string };
type RetentionState = { files: Record<string, RetentionRecord> };

/** The retention state of one workspace, loaded once and persisted after every change. */
export class AttachmentRegistry {
  private state: RetentionState | null = null;
  /** Every change runs after the previous one, so checks and changes cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupWork: Promise<number> | null = null;
  private readonly retentionFile: string;

  constructor(
    private readonly workspace: WorkspaceTransport,
    stateDirectory: string
  ) {
    this.retentionFile = join(stateDirectory, ATTACHMENT_RETENTION_FILE);
  }

  /** Records a new upload, with the type sniffed from its leading bytes. */
  async register(path: string, mimeType: string): Promise<void> {
    await this.update((state) => {
      state.files[path] ??= { createdAt: Date.now(), owners: [], mimeType };
    });
  }

  /** The type recorded at upload time, if the upload is known. */
  async mimeTypeOf(path: string): Promise<string | undefined> {
    const state = await this.load();
    return state.files[path]?.mimeType;
  }

  /** Keep uploads alive while a conversation references them. */
  async addReferences(owner: string, paths: readonly string[]): Promise<void> {
    await this.update((state) => addOwner(state, owner, paths));
  }

  /** Replace the active references of a conversation after a message deletion. */
  async setReferences(owner: string, paths: readonly string[]): Promise<void> {
    await this.update((state) => {
      removeOwner(state, owner);
      addOwner(state, owner, paths);
    });
  }

  /** Drop every reference of a deleted conversation; its uploads become collectable. */
  async releaseReferences(owner: string): Promise<void> {
    await this.update((state) => removeOwner(state, owner));
  }

  /** Remove an unreferenced upload: a discarded composer attachment, or a write that failed. */
  async removeUnused(path: string): Promise<boolean> {
    if (!ATTACHMENT_PATH.test(path)) return false;
    return this.update(async (state) => {
      const record = state.files[path];
      if (!record || record.owners.length) return false;
      await this.deleteUpload(path);
      delete state.files[path];
      return true;
    });
  }

  /** Collect old unreferenced uploads; user-created workspace outputs are outside the registry. */
  async cleanupAbandoned(now = Date.now()): Promise<number> {
    return this.update(async (state) => {
      let removed = 0;
      for (const [path, record] of Object.entries(state.files)) {
        if (
          !ATTACHMENT_PATH.test(path) ||
          record.owners.length ||
          now - record.createdAt < ABANDONED_AFTER_MS
        )
          continue;
        await this.deleteUpload(path);
        delete state.files[path];
        removed += 1;
      }
      return removed;
    });
  }

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.startCleanupRun();
    this.cleanupTimer = setInterval(() => this.startCleanupRun(), CLEANUP_EVERY_MS);
    this.cleanupTimer.unref?.();
  }

  async stopCleanup(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    await this.cleanupWork?.catch(() => {});
    await this.queue.catch(() => {});
    this.cleanupWork = null;
  }

  /** A timer tick does nothing while the previous cleanup run is still pending. */
  private startCleanupRun(): void {
    if (this.cleanupWork) return;
    const work: Promise<number> = this.cleanupAbandoned()
      .catch((error) => {
        console.error('[workspace] attachment cleanup failed:', error);
        return 0;
      })
      .finally(() => {
        if (this.cleanupWork === work) this.cleanupWork = null;
      });
    this.cleanupWork = work;
  }

  /**
   * Runs one change to the retention state after every earlier change, then
   * persists it. A failed change is not persisted.
   */
  private update<T>(change: (state: RetentionState) => T | Promise<T>): Promise<T> {
    const run = this.queue
      .catch(() => {})
      .then(async () => {
        const state = await this.load();
        const result = await change(state);
        await this.save(state);
        return result;
      });
    this.queue = run;
    return run;
  }

  /**
   * Missing state is empty. Any other read or parse error throws, and the state is
   * never replaced by an empty one, so the next save cannot erase the references.
   */
  private async load(): Promise<RetentionState> {
    if (this.state) return this.state;
    const text = await readFile(this.retentionFile, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    );
    this.state = text === null ? { files: {} } : parseState(text);
    return this.state;
  }

  private async save(state: RetentionState): Promise<void> {
    await mkdir(dirname(this.retentionFile), { recursive: true });
    const temporary = `${this.retentionFile}.tmp`;
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, this.retentionFile);
  }

  /** Deletes the upload and its directory when that is empty; a file already gone is not an error. */
  private async deleteUpload(path: string): Promise<void> {
    await this.workspace.deleteFile(path).catch(ignoreMissing);
    await this.workspace.removeEmptyDirectory(dirname(path)).catch(ignoreMissing);
  }
}

function parseState(text: string): RetentionState {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('attachment retention state must be an object');
  const files: RetentionState['files'] = {};
  if (isRecord(parsed.files)) {
    for (const [file, value] of Object.entries(parsed.files)) {
      if (
        isRecord(value) &&
        typeof value.createdAt === 'number' &&
        Array.isArray(value.owners) &&
        value.owners.every((owner) => typeof owner === 'string')
      ) {
        const record: RetentionRecord = { createdAt: value.createdAt, owners: value.owners };
        if (typeof value.mimeType === 'string') record.mimeType = value.mimeType;
        files[file] = record;
      }
    }
  }
  return { files };
}

function addOwner(state: RetentionState, owner: string, paths: readonly string[]): void {
  for (const path of paths) {
    if (!ATTACHMENT_PATH.test(path)) continue;
    const record = state.files[path];
    if (record && !record.owners.includes(owner)) record.owners.push(owner);
  }
}

function removeOwner(state: RetentionState, owner: string): void {
  for (const record of Object.values(state.files))
    record.owners = record.owners.filter((item) => item !== owner);
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ENOENT') throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
