import type { WorkspaceTransport } from '@artemis/workspace';
import { dirname } from 'node:path';
import type { ChatAttachment } from '../../chat-types';
import { ATTACHMENT_PATH } from './attachment-policy';

/**
 * Owners (conversations) of the uploads in `data/attachments`. An upload stays
 * while a conversation references it; unreferenced uploads are removed when the
 * user discards them, or once they have been abandoned for a day. Files the
 * agent writes are outside this registry.
 */
const RETENTION_FILE = 'data/attachment-retention.json';
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;

type RetentionRecord = { createdAt: number; owners: string[] };
type RetentionState = { files: Record<string, RetentionRecord> };

/** The retention state of one workspace, loaded once and persisted after every change. */
export class AttachmentRegistry {
  private state: RetentionState | null = null;
  private writes: Promise<void> = Promise.resolve();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupWork: Promise<number> | null = null;

  constructor(private readonly workspace: WorkspaceTransport) {}

  async register(path: string): Promise<void> {
    const state = await this.load();
    state.files[path] ??= { createdAt: Date.now(), owners: [] };
    await this.persist(state);
  }

  /** Keep uploads alive while a conversation references them. */
  async addReferences(owner: string, attachments: readonly ChatAttachment[]): Promise<void> {
    const state = await this.load();
    addOwner(state, owner, attachments);
    await this.persist(state);
  }

  /** Replace the active references of a conversation after a message deletion. */
  async setReferences(owner: string, attachments: readonly ChatAttachment[]): Promise<void> {
    const state = await this.load();
    removeOwner(state, owner);
    addOwner(state, owner, attachments);
    await this.persist(state);
  }

  /** Drop every reference of a deleted conversation; its uploads become collectable. */
  async releaseReferences(owner: string): Promise<void> {
    const state = await this.load();
    removeOwner(state, owner);
    await this.persist(state);
  }

  /** Remove an unreferenced upload: a discarded composer attachment, or a write that failed. */
  async removeUnused(path: string): Promise<boolean> {
    if (!ATTACHMENT_PATH.test(path)) return false;
    const state = await this.load();
    const record = state.files[path];
    if (!record || record.owners.length) return false;
    await this.removeRegistered(path, state);
    return true;
  }

  /** Collect old unreferenced uploads; user-created workspace outputs are outside the registry. */
  async cleanupAbandoned(now = Date.now()): Promise<number> {
    const state = await this.load();
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
    if (removed) await this.persist(state);
    return removed;
  }

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupWork = this.runCleanup();
    this.cleanupTimer = setInterval(() => {
      this.cleanupWork = this.runCleanup();
    }, CLEANUP_EVERY_MS);
    this.cleanupTimer.unref?.();
  }

  async stopCleanup(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    await this.cleanupWork?.catch(() => {});
    await this.writes;
    this.cleanupWork = null;
  }

  private runCleanup(): Promise<number> {
    return this.cleanupAbandoned().catch((error) => {
      console.error('[workspace] attachment cleanup failed:', error);
      return 0;
    });
  }

  private async load(): Promise<RetentionState> {
    if (this.state) return this.state;
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(await this.workspace.readFile(RETENTION_FILE)).toString('utf8')
      );
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
            files[file] = { createdAt: value.createdAt, owners: value.owners };
          }
        }
      }
      this.state = { files };
    } catch {
      this.state = { files: {} };
    }
    return this.state;
  }

  private persist(state: RetentionState): Promise<void> {
    this.writes = this.writes
      .catch(() => {})
      .then(() => this.workspace.writeFile(RETENTION_FILE, JSON.stringify(state)));
    return this.writes;
  }

  private async removeRegistered(path: string, state: RetentionState): Promise<void> {
    await this.deleteUpload(path);
    delete state.files[path];
    await this.persist(state);
  }

  /** Deletes the upload and its directory when that is empty; a file already gone is not an error. */
  private async deleteUpload(path: string): Promise<void> {
    await this.workspace.deleteFile(path).catch(ignoreMissing);
    await this.workspace.removeEmptyDirectory(dirname(path)).catch(ignoreMissing);
  }
}

function addOwner(
  state: RetentionState,
  owner: string,
  attachments: readonly ChatAttachment[]
): void {
  for (const attachment of attachments) {
    if (!ATTACHMENT_PATH.test(attachment.path)) continue;
    const record = state.files[attachment.path];
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
