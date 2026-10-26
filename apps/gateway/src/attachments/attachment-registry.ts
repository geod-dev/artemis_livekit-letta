import type { WorkspaceTransport } from '@artemis/workspace';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ATTACHMENT_PATH,
  ATTACHMENT_RETENTION_FILE,
  AttachmentUnavailableError,
} from './attachment-policy.ts';

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

/** The type and kind of an upload, decided once from its leading bytes. */
export type UploadRecord = { kind: 'image' | 'file'; mimeType: string };
/**
 * `owners` holds one entry per reservation (`<conversation>#<uuid>`), so each turn
 * releases only its own reference; a plain conversation id is a legacy or
 * replaced-message owner. `unreferencedAt` is when the last owner was removed.
 */
type RetentionRecord = UploadRecord & {
  createdAt: number;
  owners: string[];
  unreferencedAt?: number;
};
type RetentionState = { files: Record<string, RetentionRecord> };

/** The retention state of one workspace, loaded once and persisted after every change. */
export class AttachmentRegistry {
  private state: RetentionState | null = null;
  /** Every read and change runs after the previous one, so the state file is never read mid-rename. */
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

  /** Records a new upload with the type and kind sniffed from its leading bytes. */
  async register(path: string, upload: UploadRecord): Promise<void> {
    await this.update((state) => {
      state.files[path] ??= { createdAt: Date.now(), owners: [], ...upload };
    });
  }

  /** The type and kind recorded at upload time, or undefined when the upload is unknown. */
  uploadOf(path: string): Promise<UploadRecord | undefined> {
    return this.read((state) => {
      const record = ATTACHMENT_PATH.test(path) ? state.files[path] : undefined;
      return record ? { kind: record.kind, mimeType: record.mimeType } : undefined;
    });
  }

  /**
   * Keep uploads alive while a conversation references them. Reports the paths
   * that could not be referenced (unknown or already removed) and the ones this
   * call newly added, so a caller can undo exactly its own references.
   */
  async addReferences(
    owner: string,
    paths: readonly string[]
  ): Promise<{ missing: string[]; added: string[] }> {
    return this.update((state) => addOwner(state, owner, paths));
  }

  /**
   * Reserves the uploads of a turn before the agent-server sees the turn. Fails with
   * AttachmentUnavailableError when one of them is unknown or already removed, and
   * keeps nothing from a refused reservation. The returned function gives back the
   * references this turn added; the route calls it when the turn is not accepted.
   */
  async reserveReferences(
    conversation: string,
    paths: readonly string[]
  ): Promise<() => Promise<void>> {
    const owner = `${conversation}#${randomUUID()}`;
    const added = await this.update((state) => {
      const unavailable = paths.some((path) => !ATTACHMENT_PATH.test(path) || !state.files[path]);
      if (unavailable) throw new AttachmentUnavailableError();
      return addOwner(state, owner, paths).added;
    });
    return () => this.removeReferences(owner, added);
  }

  /** Undo the references of one owner, as returned by `reserveReferences`. */
  async removeReferences(owner: string, paths: readonly string[]): Promise<void> {
    await this.update((state) => {
      for (const path of paths) {
        const record = state.files[path];
        if (record) dropOwners(record, (item) => item === owner);
      }
    });
  }

  /** Replace the active references of a conversation after a message deletion. */
  async setReferences(conversation: string, paths: readonly string[]): Promise<void> {
    await this.update((state) => {
      removeOwner(state, conversation);
      addOwner(state, conversation, paths);
    });
  }

  /** Drop every reference of a deleted conversation, including each turn's; its uploads become collectable. */
  async releaseReferences(conversation: string): Promise<void> {
    await this.update((state) => removeOwner(state, conversation));
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
          now - (record.unreferencedAt ?? record.createdAt) < ABANDONED_AFTER_MS
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
        console.error('[attachments] cleanup failed:', error);
        return 0;
      })
      .finally(() => {
        if (this.cleanupWork === work) this.cleanupWork = null;
      });
    this.cleanupWork = work;
  }

  /** Runs one task after every earlier read and change. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(task);
    this.queue = run;
    return run;
  }

  /** Reads the retention state after every earlier change. */
  private read<T>(pick: (state: RetentionState) => T): Promise<T> {
    return this.serialize(async () => pick(await this.load()));
  }

  /**
   * Runs one change to the retention state after every earlier change, then
   * persists it. The change runs on a copy, and the cached state moves to the copy
   * only after the save succeeds, so a failed change or save leaves no trace in memory.
   */
  private update<T>(change: (state: RetentionState) => T | Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const next = structuredClone(await this.load());
      const result = await change(next);
      await this.save(next);
      this.state = next;
      return result;
    });
  }

  /**
   * Missing state is empty. Any other read or parse error throws, and the state is
   * never replaced by an empty one, so the next save cannot erase the references.
   * Callers reach this only through `serialize`.
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
    // A unique temporary name per write, flushed to disk before the rename replaces the state.
    const temporary = `${this.retentionFile}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'w');
      try {
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.retentionFile);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
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
  if (!isRecord(parsed.files)) throw new Error('attachment retention files must be an object');
  const files: RetentionState['files'] = {};
  for (const [file, value] of Object.entries(parsed.files)) {
    // An invalid record is a load error, like a corrupt file: it is never dropped on save.
    if (!isRetentionRecord(value))
      throw new Error(`attachment retention record ${file} is invalid`);
    files[file] = value;
  }
  return { files };
}

function isRetentionRecord(value: unknown): value is RetentionRecord {
  return (
    isRecord(value) &&
    typeof value.createdAt === 'number' &&
    Array.isArray(value.owners) &&
    value.owners.every((owner) => typeof owner === 'string') &&
    typeof value.mimeType === 'string' &&
    (value.kind === 'image' || value.kind === 'file') &&
    (value.unreferencedAt === undefined || typeof value.unreferencedAt === 'number')
  );
}

function addOwner(
  state: RetentionState,
  owner: string,
  paths: readonly string[]
): { missing: string[]; added: string[] } {
  const missing: string[] = [];
  const added: string[] = [];
  for (const path of paths) {
    const record = ATTACHMENT_PATH.test(path) ? state.files[path] : undefined;
    if (!record) {
      missing.push(path);
    } else if (!record.owners.includes(owner)) {
      record.owners.push(owner);
      delete record.unreferencedAt;
      added.push(path);
    }
  }
  return { missing, added };
}

/** Removes every owner of one conversation: its legacy owner and each turn's reservation. */
function removeOwner(state: RetentionState, conversation: string): void {
  for (const record of Object.values(state.files))
    dropOwners(record, (item) => ownerConversation(item) === conversation);
}

/** Drops the matching owners, and stamps the moment the upload lost its last one. */
function dropOwners(record: RetentionRecord, drop: (owner: string) => boolean): void {
  const owners = record.owners.filter((owner) => !drop(owner));
  if (owners.length === record.owners.length) return;
  record.owners = owners;
  if (owners.length === 0) record.unreferencedAt ??= Date.now();
}

const RESERVATION_OWNER = /^(.*)#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/s;

/** The conversation an owner belongs to: a reservation's conversation, or a legacy owner itself. */
function ownerConversation(owner: string): string {
  return RESERVATION_OWNER.exec(owner)?.[1] ?? owner;
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ENOENT') throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
