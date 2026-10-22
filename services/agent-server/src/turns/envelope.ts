import { notImplemented } from '@artemis/core';
import type { ImageBlock, UserContent } from '@artemis/llm';
import type { UserTurnEnvelope } from '@artemis/storage';

/**
 * Renders the user message of a turn. Everything volatile lives here, AFTER
 * the cached prefix (tools + frozen system prompt + previous history):
 *
 * ```
 * [<system-reminder>End your spoken response with [listen] or [done].</system-reminder>]  (voice)
 * [text|voice-short|voice-long]
 * <current_datetime>2026-10-22T10:00:00+02:00[Europe/Paris]</current_datetime>
 * <background-update id=".." task=".." status=".." [needs-input="true"]>report</background-update>...
 * <attachment kind=".." path="data/attachments/.." name=".." mime_type=".." size_bytes=".." />...
 * <system-reminder>Available MCP tools: ... | MCP tool list changed: ...</system-reminder>
 * <recalled-memories>...</recalled-memories>
 * <user-content>
 * the user's raw text
 * ```
 * + image blocks for image attachments. The rendered content is stored verbatim
 * (`messages.content`) and the structured envelope beside it (`messages.envelope`),
 * so history decoding never parses this text.
 */
export function renderUserTurn(_envelope: UserTurnEnvelope, _images: ImageBlock[]): UserContent[] {
  return notImplemented('renderUserTurn');
}

/** Holds back a trailing `[listen]`/`[done]` marker from streamed voice text (port of `CallStateFilter`). */
export class CallStateFilter {
  /** The state found at the end of the response, once `flush` ran. */
  state: 'listen' | 'done' | null = null;

  push(_delta: string): string {
    return notImplemented('CallStateFilter.push');
  }

  flush(): string {
    return notImplemented('CallStateFilter.flush');
  }
}
