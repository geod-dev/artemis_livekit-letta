import type { Logger } from '@artemis/core';
import type { LlmMessage } from '@artemis/llm';
import type { MessageRecord } from '@artemis/storage';

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Runs a side effect whose failure must never fail the caller (memory, titles, delivery notices). */
export async function safely(logger: Logger, what: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    logger.error(`${what} failed`, { error: messageOf(error) });
  }
}

/** Stored transcript rows as the LLM messages they were (blocks replayed verbatim). */
export function toLlmMessages(records: readonly MessageRecord[]): LlmMessage[] {
  return records.map((record) => ({ role: record.role, content: record.content }) as unknown as LlmMessage);
}
