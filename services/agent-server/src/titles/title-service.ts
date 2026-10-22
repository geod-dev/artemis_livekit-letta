import { notImplemented } from '@artemis/core';

/**
 * Asynchronous conversation naming, never fed back to the LLM: after the first
 * user turn of an untitled conversation, `oneShot` on the `title` route with
 * `prompts/title.md` and the first 1 000 chars, 20 s timeout -> `cleanTitle`
 * (fallback: first 60 chars) -> `setTitleIfUntitled` (a user rename wins) ->
 * publish `conversation_updated`. At most one request in flight per conversation.
 */
export abstract class TitleService {
  abstract request(conversationId: string, firstUserText: string): void;
  abstract stop(): Promise<void>;
}

/** Port of backend/src/assistant/conversations/title-text.ts. */
export function cleanTitle(_raw: string): string | null {
  return notImplemented('cleanTitle');
}

export function fallbackTitle(_text: string): string {
  return notImplemented('fallbackTitle');
}

export function createTitleService(): TitleService {
  return notImplemented('createTitleService');
}
