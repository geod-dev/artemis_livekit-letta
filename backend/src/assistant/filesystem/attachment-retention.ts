import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatAttachment } from '../../chat-types';
import { config } from '../config';

/**
 * Owners (conversations) of the uploads in `data/attachments`. An upload stays
 * while a conversation references it; unreferenced uploads are removed when the
 * user discards them, or once they have been abandoned for a day. Files the
 * agent writes are outside this registry.
 */
const ATTACHMENT_PATH =
  /^data\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/\\]+$/;
const RETENTION_FILE = 'data/attachment-retention.json';
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;

export { ATTACHMENT_PATH };

type RetentionRecord = { createdAt: number; owners: string[] };
type RetentionState = { files: Record<string, RetentionRecord> };
let retentionCache: RetentionState | null = null;
let retentionRoot: string | null = null;
let retentionWrite = Promise.resolve();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let cleanupWork: Promise<number> | null = null;

async function loadRetention(): Promise<RetentionState> {
  if (retentionCache && retentionRoot === config.workspace.dir) return retentionCache;
  retentionRoot = config.workspace.dir;
  const path = join(config.workspace.dir, RETENTION_FILE);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
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
    retentionCache = { files };
  } catch {
    retentionCache = { files: {} };
  }
  return retentionCache;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function persistRetention(state: RetentionState, root: string): Promise<void> {
  const path = join(root, RETENTION_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state));
}

function queueRetentionWrite(state: RetentionState): Promise<void> {
  const root = retentionRoot ?? config.workspace.dir;
  retentionWrite = retentionWrite.catch(() => {}).then(() => persistRetention(state, root));
  return retentionWrite;
}

export async function registerAttachment(path: string): Promise<void> {
  const state = await loadRetention();
  state.files[path] ??= { createdAt: Date.now(), owners: [] };
  await queueRetentionWrite(state);
}

/** Keep uploads alive while a conversation references them. */
export async function addAttachmentReferences(owner: string, attachments: readonly ChatAttachment[]): Promise<void> {
  const state = await loadRetention();
  for (const attachment of attachments) {
    if (!ATTACHMENT_PATH.test(attachment.path)) continue;
    const record = state.files[attachment.path];
    if (record && !record.owners.includes(owner)) record.owners.push(owner);
  }
  await queueRetentionWrite(state);
}

/** Replace the active references of a conversation after a message deletion. */
export async function setAttachmentReferences(owner: string, attachments: readonly ChatAttachment[]): Promise<void> {
  const state = await loadRetention();
  for (const record of Object.values(state.files)) record.owners = record.owners.filter((item) => item !== owner);
  for (const attachment of attachments) {
    if (!ATTACHMENT_PATH.test(attachment.path)) continue;
    const record = state.files[attachment.path];
    if (record && !record.owners.includes(owner)) record.owners.push(owner);
  }
  await queueRetentionWrite(state);
}

/** Drop every reference of a deleted conversation; its uploads become collectable. */
export async function releaseAttachmentReferences(owner: string): Promise<void> {
  const state = await loadRetention();
  for (const record of Object.values(state.files)) record.owners = record.owners.filter((item) => item !== owner);
  await queueRetentionWrite(state);
}

/** Remove an unreferenced upload: a discarded composer attachment, or a write that failed. */
export async function removeUnusedAttachment(path: string): Promise<boolean> {
  if (!ATTACHMENT_PATH.test(path)) return false;
  const state = await loadRetention();
  const record = state.files[path];
  if (!record || record.owners.length) return false;
  return removeRegisteredAttachment(path, state);
}

async function removeRegisteredAttachment(path: string, state: RetentionState): Promise<boolean> {
  const target = join(config.workspace.dir, path);
  await deleteAttachmentFile(target);
  delete state.files[path];
  await queueRetentionWrite(state);
  return true;
}

/** Collect old unreferenced uploads; user-created workspace outputs are outside the registry. */
export async function cleanupAbandonedAttachments(now = Date.now()): Promise<number> {
  const state = await loadRetention();
  let removed = 0;
  for (const [path, record] of Object.entries(state.files)) {
    if (!ATTACHMENT_PATH.test(path) || record.owners.length || now - record.createdAt < ABANDONED_AFTER_MS) continue;
    const target = join(config.workspace.dir, path);
    await deleteAttachmentFile(target);
    delete state.files[path];
    removed += 1;
  }
  if (removed) await queueRetentionWrite(state);
  return removed;
}

async function deleteAttachmentFile(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await rmdir(dirname(path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
  });
}

export function startAttachmentCleanup(): void {
  if (cleanupTimer) return;
  cleanupWork = cleanupAbandonedAttachments().catch((error) => {
    console.error('[workspace] attachment cleanup failed:', error);
    return 0;
  });
  cleanupTimer = setInterval(() => {
    cleanupWork = cleanupAbandonedAttachments().catch((error) => {
      console.error('[workspace] attachment cleanup failed:', error);
      return 0;
    });
  }, CLEANUP_EVERY_MS);
  cleanupTimer.unref?.();
}

export async function stopAttachmentCleanup(): Promise<void> {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
  await cleanupWork?.catch(() => {});
  await retentionWrite;
  cleanupWork = null;
}
