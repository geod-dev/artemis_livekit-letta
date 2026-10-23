import { AppError, IMAGE_MEDIA_TYPES, type ImageMediaType } from '@artemis/core';
import type { AssistantContent, LlmMessage, ToolDefinition, UserContent } from '@artemis/llm';
import type { MessageRecord } from '@artemis/storage';

/** Stored transcript rows as the LLM messages they were (blocks replayed verbatim). */
export function toLlmMessages(records: readonly MessageRecord[]): LlmMessage[] {
  return records.map((record): LlmMessage =>
    record.role === 'user'
      ? { role: 'user', content: record.content as UserContent[] }
      : { role: 'assistant', content: record.content as AssistantContent[] }
  );
}

/** Tool definitions frozen in a prompt snapshot (stored as JSON); anything else is a corrupt snapshot. */
export function snapshotToolDefinitions(tools: readonly unknown[], ownerId: string): ToolDefinition[] {
  return tools.map((tool) => {
    if (!isToolDefinition(tool)) throw new AppError('snapshot_invalid', `Prompt snapshot of ${ownerId} holds an invalid tool`, 500);
    return tool;
  });
}

/** Media type of an attachment that can be sent inline to the model, or null. */
export function inlineImageType(mimeType: string | undefined): ImageMediaType | null {
  return IMAGE_MEDIA_TYPES.find((type) => type === mimeType) ?? null;
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ToolDefinition>;
  return typeof candidate.name === 'string' && typeof candidate.description === 'string' && typeof candidate.inputSchema === 'object' && candidate.inputSchema !== null;
}
