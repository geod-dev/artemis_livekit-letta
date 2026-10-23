import type { Logger } from '@artemis/core';
import { errorMessage } from '@artemis/core';
import type { ChatAttachment, ChatMessage } from '@artemis/contracts/chat-types';
import type { ImageBlock } from '@artemis/llm';
import type { BackgroundUpdateRecord, DeliveredUpdate, RecalledMemory, UserTurnEnvelope } from '@artemis/storage';
import type { WorkspaceTransport } from '@artemis/workspace';
import { updateEventRow } from '../../tasks/delivery.ts';
import { inlineImageType } from '../codecs.ts';
import type { TurnSubmission } from '../types.ts';
import type { TurnState } from './turn-state.ts';

const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/** The structured envelope of a turn's user message (rendered and stored beside its text). */
export function userEnvelope(input: {
  submission: TurnSubmission;
  claimed: readonly BackgroundUpdateRecord[];
  memories: RecalledMemory[];
  mcpReminder?: string;
  currentDateTime: string;
}): UserTurnEnvelope {
  const { submission: sub } = input;
  return {
    version: 2,
    mode: sub.mode,
    text: sub.text,
    currentDateTime: input.currentDateTime,
    attachments: sub.attachments ?? [],
    updates: input.claimed.map(toDeliveredUpdate),
    recalledMemories: input.memories,
    ...(input.mcpReminder ? { mcpReminder: input.mcpReminder } : {}),
    ...(sub.clientMessageId ? { clientMessageId: sub.clientMessageId } : {}),
  };
}

/** Live rows of this turn: the updates it delivers, then the user's message. */
export function echoRows(state: TurnState, messageId: string, createdAt: string): ChatMessage[] {
  const sub = state.submission;
  const rows: ChatMessage[] = state.claimed.map(updateEventRow);
  if (sub.kind === 'user' && (sub.text || (sub.attachments?.length ?? 0) > 0)) {
    rows.push({
      id: messageId,
      role: 'user',
      text: sub.text,
      modality: sub.modality,
      ...(sub.attachments?.length ? { attachments: sub.attachments } : {}),
      createdAt,
      ...(sub.clientMessageId ? { clientMessageId: sub.clientMessageId } : {}),
    });
  }
  return rows;
}

/** Small image attachments, read through the workspace, sent inline to the model. */
export async function inlineImages(workspace: WorkspaceTransport, logger: Logger, attachments: readonly ChatAttachment[]): Promise<ImageBlock[]> {
  const images: ImageBlock[] = [];
  for (const attachment of attachments) {
    if (attachment.kind !== 'image') continue;
    try {
      const mediaType = inlineImageType(attachment.mimeType);
      if (!mediaType) continue;
      const stat = await workspace.stat(attachment.path);
      if (!stat || stat.size > MAX_INLINE_IMAGE_BYTES) continue;
      const bytes = await workspace.readFile(attachment.path);
      images.push({ type: 'image', mediaType, data: Buffer.from(bytes).toString('base64') });
    } catch (error) {
      logger.warn('attachment could not be read', { path: attachment.path, error: errorMessage(error) });
    }
  }
  return images;
}

/** Recall query of an update turn: the titles and first report lines it delivers. */
export function updateQuery(updates: readonly BackgroundUpdateRecord[]): string {
  return updates.map((update) => `${update.title}: ${update.report.split('\n').find((line) => line.trim()) ?? ''}`).join('\n');
}

function toDeliveredUpdate(update: BackgroundUpdateRecord): DeliveredUpdate {
  return {
    id: update.id,
    taskId: update.taskId,
    title: update.title,
    status: update.status,
    needsInput: update.needsInput,
    report: update.report,
    ...(update.durationMs !== null ? { durationMs: update.durationMs } : {}),
  };
}
