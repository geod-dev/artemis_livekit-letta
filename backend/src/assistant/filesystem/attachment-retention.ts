import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatAttachment } from '../../chat-types';
import { config } from '../config';

const ATTACHMENT_PATH =
  /^data\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/\\]+$/;
const RETENTION_FILE = 'data/attachment-retention.json';
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;

export { ATTACHMENT_PATH };

type RetentionRecord = { createdAt: number; owners: string[]; kind: 'upload' | 'mcp-output' };
type RetentionState = {
  files: Record<string, RetentionRecord>;
  tokens: Record<string, { createdAt: number; paths: string[] }>;
};
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
          files[file] = {
            createdAt: value.createdAt,
            owners: value.owners,
            // Old records did not distinguish uploads from generated outputs.
            // Treat them as outputs so an upgrade cannot delete canonical history.
            kind: value.kind === 'upload' ? 'upload' : 'mcp-output',
          };
        }
      }
    }
    const tokens: RetentionState['tokens'] = {};
    if (isRecord(parsed.tokens)) {
      for (const [token, value] of Object.entries(parsed.tokens)) {
        if (
          isRecord(value) &&
          typeof value.createdAt === 'number' &&
          Array.isArray(value.paths) &&
          value.paths.every((item) => typeof item === 'string')
        ) {
          tokens[token] = { createdAt: value.createdAt, paths: value.paths };
        }
      }
    }
    retentionCache = {
      files,
      tokens,
    };
  } catch {
    retentionCache = { files: {}, tokens: {} };
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

export async function registerAttachment(path: string, kind: RetentionRecord['kind'] = 'upload'): Promise<void> {
  const state = await loadRetention();
  state.files[path] ??= { createdAt: Date.now(), owners: [], kind };
  await queueRetentionWrite(state);
}

/** Keep app-owned uploads alive while an active conversation references them. */
export async function addAttachmentReferences(owner: string, attachments: readonly ChatAttachment[]): Promise<void> {
  const state = await loadRetention();
  for (const attachment of attachments) {
    if (!ATTACHMENT_PATH.test(attachment.path)) continue;
    const record = state.files[attachment.path];
    if (record && !record.owners.includes(owner)) record.owners.push(owner);
  }
  await queueRetentionWrite(state);
}

/** Persist the handoff for MCP artifacts until history claims it. */
export async function createAttachmentReferenceToken(paths: readonly string[]): Promise<string | null> {
  const accepted = [...new Set(paths)].filter((path) => ATTACHMENT_PATH.test(path));
  if (accepted.length === 0) return null;
  const state = await loadRetention();
  pruneExpiredUploadTokens(state, Date.now());
  if (Object.keys(state.tokens).length >= 2048)
    throw new Error('MCP attachment reference capacity reached; retry after pending results are reconciled');
  const token = randomUUID();
  state.tokens[token] = { createdAt: Date.now(), paths: accepted };
  await queueRetentionWrite(state);
  return token;
}

/** Claim a bridge-created token; paths are rechecked against the managed registry. */
export async function claimAttachmentReferenceToken(owner: string, token: string): Promise<boolean> {
  const state = await loadRetention();
  const pending = state.tokens[token];
  if (!pending) return false;
  const added: RetentionRecord[] = [];
  for (const path of pending.paths) {
    const record = state.files[path];
    if (record && !record.owners.includes(owner)) {
      record.owners.push(owner);
      added.push(record);
    }
  }
  delete state.tokens[token];
  try {
    await queueRetentionWrite(state);
  } catch (error) {
    state.tokens[token] = pending;
    for (const record of added) record.owners = record.owners.filter((item) => item !== owner);
    throw error;
  }
  return true;
}

/** Replace the active references after a message deletion/fork. */
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

export async function releaseAttachmentReferences(owner: string): Promise<void> {
  const state = await loadRetention();
  for (const record of Object.values(state.files)) record.owners = record.owners.filter((item) => item !== owner);
  await queueRetentionWrite(state);
}

/** Remove an unreferenced app upload when a composer attachment is discarded. */
export async function removeUnusedAttachment(path: string): Promise<boolean> {
  if (!ATTACHMENT_PATH.test(path)) return false;
  const state = await loadRetention();
  const record = state.files[path];
  if (!record || record.kind !== 'upload' || record.owners.length) return false;
  return removeRegisteredAttachment(path, state);
}

/** Roll back a write that failed before its generated output was returned. */
export async function removeUnwrittenAttachment(path: string): Promise<boolean> {
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

/** Collect old unreferenced app uploads; user-created workspace outputs are outside the registry. */
export async function cleanupAbandonedAttachments(now = Date.now()): Promise<number> {
  const state = await loadRetention();
  const pendingPaths = new Set<string>();
  const changed = pruneExpiredUploadTokens(state, now);
  for (const pending of Object.values(state.tokens)) {
    const expired = now - pending.createdAt >= ABANDONED_AFTER_MS;
    for (const path of pending.paths) {
      const record = state.files[path];
      if (!record || (expired && record.kind === 'upload')) continue;
      pendingPaths.add(path);
    }
  }
  let removed = 0;
  for (const [path, record] of Object.entries(state.files)) {
    if (record.kind !== 'upload' || !ATTACHMENT_PATH.test(path) || record.owners.length || pendingPaths.has(path) || now - record.createdAt < ABANDONED_AFTER_MS) continue;
    const target = join(config.workspace.dir, path);
    await deleteAttachmentFile(target);
    delete state.files[path];
    removed += 1;
  }
  if (removed || changed) await queueRetentionWrite(state);
  return removed;
}

/** Expired upload-only handoffs can go away; tokens protecting generated outputs are durable. */
function pruneExpiredUploadTokens(state: RetentionState, now: number): boolean {
  let changed = false;
  for (const [token, pending] of Object.entries(state.tokens)) {
    if (now - pending.createdAt < ABANDONED_AFTER_MS) continue;
    const protectsOutput = pending.paths.some((path) => state.files[path]?.kind === 'mcp-output');
    if (!protectsOutput) {
      delete state.tokens[token];
      changed = true;
    }
  }
  return changed;
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

