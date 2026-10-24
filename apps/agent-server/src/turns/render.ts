import type { ChatAttachment } from '@artemis/contracts/chat-types';
import type { ImageBlock, UserContent } from '@artemis/llm';
import { renderRecalledMemories } from '@artemis/memory';
import type { DeliveredUpdate, UserTurnEnvelope } from '@artemis/storage';
import { toMemoryFact } from '../memory/to-memory-fact.ts';

/**
 * Renders the user message of a turn. Everything volatile lives here, AFTER
 * the cached prefix (tools + frozen system prompt + previous history):
 *
 * ```
 * [<system-reminder>End your spoken response with [listen] or [done].</system-reminder>]  (voice)
 * [text|voice-short|voice-long]
 * <current_datetime>2026-10-22T10:00:00+02:00[Europe/Paris]</current_datetime>
 * <background-update id=".." task=".." status=".." [needs-input="true"]>report</background-update>...
 * <attachment kind=".." path="data/attachments/.." name=".." .../>...
 * <system-reminder>Available MCP tools: ... | MCP tool list changed: ...</system-reminder>
 * <recalled-memories>...</recalled-memories>
 * <user-content>
 * the user's raw text
 * </user-content>
 * ```
 * + image blocks for image attachments. The rendered text is stored verbatim
 * (`messages.content`) and the structured envelope beside it (`messages.envelope`),
 * so history decoding never parses this text.
 */
export function renderUserTurn(envelope: UserTurnEnvelope, images: readonly ImageBlock[] = []): UserContent[] {
  const head: string[] = [];
  if (envelope.mode !== 'text') head.push(VOICE_REMINDER);
  head.push(`[${envelope.mode}]`);
  head.push(`<current_datetime>${escapeText(envelope.currentDateTime)}</current_datetime>`);
  for (const update of envelope.updates) head.push(encodeBackgroundUpdate(update));
  for (const attachment of envelope.attachments) head.push(encodeAttachment(attachment));
  if (envelope.mcpReminder) head.push(envelope.mcpReminder);
  const memories = renderRecalledMemories(envelope.recalledMemories.map(toMemoryFact));
  if (memories) head.push(memories);

  const text = envelope.text.trim()
    ? [...head, '<user-content>', envelope.text, '</user-content>'].join('\n')
    : head.join('\n');
  return [{ type: 'text', text }, ...images];
}

/** Voice turns repeat the call-state rule: the voice model follows a per-turn reminder far more reliably. */
const VOICE_REMINDER =
  '<system-reminder>End your spoken response with [listen] if it asks the user anything or waits for their answer, otherwise with [done].</system-reminder>';

/** Encoded `<background-update>` block (the report is data, its closing tag escaped). */
function encodeBackgroundUpdate(update: Pick<DeliveredUpdate, 'id' | 'taskId' | 'title' | 'status' | 'needsInput' | 'report'>): string {
  const attrs = [
    `id="${escapeAttr(update.id)}"`,
    `task="${escapeAttr(update.title)}"`,
    `status="${update.status}"`,
    ...(update.needsInput ? ['needs-input="true"'] : []),
  ].join(' ');
  const body = update.report.replaceAll('</background-update', '<\\/background-update');
  return `<background-update ${attrs}>\n${body}\n</background-update>`;
}

function encodeAttachment(attachment: ChatAttachment): string {
  const attrs = [
    `kind="${attachment.kind}"`,
    `path="${escapeAttr(attachment.path)}"`,
    `name="${escapeAttr(attachment.name)}"`,
    ...(attachment.mimeType ? [`mime_type="${escapeAttr(attachment.mimeType)}"`] : []),
    ...(attachment.size !== undefined ? [`size_bytes="${attachment.size}"`] : []),
  ];
  return `<attachment ${attrs.join(' ')} />`;
}

/** `2026-10-22T10:00:00+02:00[Europe/Paris]` for the given instant and IANA zone. */
export function formatCurrentDateTime(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(epochMs));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  const local = `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}`;
  const offset = (parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT').replace('GMT', '') || '+00:00';
  return `${local}${offset}[${timeZone}]`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
