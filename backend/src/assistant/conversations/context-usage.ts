import type { SDKMessage } from '@letta-ai/letta-agent-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConversationContextUsage } from '../../chat-types';
import { config } from '../config';
import { letta } from '../letta/agent-client.ts';
import { publish } from './events.ts';

const pending = new Map<string, Promise<void>>();

/** Context is a snapshot, not accumulated billable usage across model calls. */
export function lettaContextTokens(message: SDKMessage): number | undefined {
  if (message.type !== 'stream_event' || message.event.message_type !== 'usage_statistics')
    return undefined;
  const tokens = message.event.context_tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Read the effective runtime limit, including any per-conversation override. */
export function contextWindowFromEntity(value: unknown): number | undefined {
  const entity = record(value);
  const limit = entity?.context_window_limit ?? record(entity?.llm_config)?.context_window;
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

function snapshotPath(id: string): string {
  const key = createHash('sha256').update(id).digest('hex');
  return join(config.workspace.dataDir, 'context-usage', `${key}.json`);
}

/** Persist only Letta's reported context, so refreshes/restarts retain the last snapshot. */
export async function recordLettaContextUsage(id: string, usedTokens: number): Promise<void> {
  if (!Number.isFinite(usedTokens) || usedTokens < 0) return;
  const previous = pending.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const conversation = await letta().conversations.retrieve(id);
      let windowTokens = contextWindowFromEntity(conversation);
      if (windowTokens === undefined) {
        windowTokens = contextWindowFromEntity(
          await letta().agents.retrieve(conversation.agent_id)
        );
      }
      // An unknown runtime limit must not become a guessed model capacity.
      if (windowTokens === undefined) {
        await unlink(snapshotPath(id)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
        publish(id, { type: 'context_usage' });
        return;
      }
      const snapshot: ConversationContextUsage = {
        usedTokens,
        windowTokens,
        model: conversation.model ?? null,
        reportedAt: new Date().toISOString(),
      };
      const directory = join(config.workspace.dataDir, 'context-usage');
      await mkdir(directory, { recursive: true });
      const path = snapshotPath(id);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(snapshot), 'utf8');
        await rename(temporary, path);
        publish(id, { type: 'context_usage' });
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
  pending.set(id, next);
  try {
    await next;
  } catch (error) {
    console.warn(`[context] Could not retain Letta usage for ${id}:`, error);
  } finally {
    if (pending.get(id) === next) pending.delete(id);
  }
}

export async function readLettaContextUsage(id: string): Promise<ConversationContextUsage | null> {
  await pending.get(id)?.catch(() => {});
  try {
    const value: unknown = JSON.parse(await readFile(snapshotPath(id), 'utf8'));
    const row = record(value);
    if (
      !row ||
      typeof row.usedTokens !== 'number' ||
      !Number.isFinite(row.usedTokens) ||
      row.usedTokens < 0 ||
      typeof row.windowTokens !== 'number' ||
      !Number.isFinite(row.windowTokens) ||
      row.windowTokens <= 0 ||
      (row.model !== null && typeof row.model !== 'string') ||
      typeof row.reportedAt !== 'string'
    )
      return null;
    return row as unknown as ConversationContextUsage;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`[context] Could not read Letta usage for ${id}:`, error);
    return null;
  }
}
