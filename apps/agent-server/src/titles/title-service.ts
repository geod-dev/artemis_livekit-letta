import { oneShot } from '@artemis/agent-loop';
import { DEFAULT_CONVERSATION_TITLE } from '@artemis/contracts/chat-types';
import { consoleLogger, errorMessage, type Logger } from '@artemis/core';
import type { Storage } from '@artemis/storage';
import type { ConversationEventHub } from '../events/hub.ts';
import type { ModelRouter } from '../models/routing.ts';
import type { PromptRenderer } from '../prompts/renderer.ts';

/**
 * Asynchronous conversation naming, never fed back to the LLM: after the first
 * user turn of an untitled conversation, `oneShot` on the `title` route with
 * `templates/title.md` and the first 1 000 chars, 20 s timeout -> `cleanTitle`
 * (fallback: first 60 chars) -> `setTitleIfUntitled` (a user rename wins) ->
 * publish `conversation_updated`. At most one request in flight per conversation.
 */
export interface TitleService {
  /**
   * Starts naming the conversation (or joins the request already in flight). The promise
   * resolves once that request has settled and never rejects; callers may ignore it.
   */
  request(conversationId: string, firstUserText: string): Promise<void>;
  /** Aborts requests in flight and refuses new ones. */
  stop(): Promise<void>;
}

const MAX_TITLE_LENGTH = 60;
const TITLE_INPUT_LENGTH = 1_000;
const TITLE_TIMEOUT_MS = 20_000;

/** Null when the reply holds no usable title. */
function cleanTitle(raw: string): string | null {
  const line =
    raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .split('\n')
      .map((item) => item.trim())
      .find(Boolean) ?? '';
  const title = line
    .replace(/[*_#`]/g, '')
    .replace(/^\s*(title|titre|título|titel)\s*:\s*/i, '')
    .replace(/^["'“”‘’«»\s]+|["'“”‘’«»\s]+$/g, '')
    .replace(/[.!?。！？:;,]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return null;
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : title;
}

/** The first message itself, shortened: used when the title model fails. */
function fallbackTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH) || DEFAULT_CONVERSATION_TITLE;
}

interface TitleServiceDeps {
  storage: Storage;
  router: ModelRouter;
  prompts: PromptRenderer;
  events: ConversationEventHub;
  logger?: Logger;
}

class StorageTitleService implements TitleService {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly logger: Logger;
  private stopped = false;

  constructor(private readonly deps: TitleServiceDeps) {
    this.logger = deps.logger ?? consoleLogger('titles');
  }

  request(conversationId: string, firstUserText: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.inflight.get(conversationId);
    if (existing) return existing;
    const job = this.generate(conversationId, firstUserText)
      .catch((error: unknown) => {
        this.logger.warn('title update failed', { conversationId, message: errorMessage(error) });
      })
      .finally(() => {
        this.inflight.delete(conversationId);
      });
    this.inflight.set(conversationId, job);
    return job;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await Promise.allSettled([...this.inflight.values()]);
  }

  private async generate(conversationId: string, firstUserText: string): Promise<void> {
    const { storage, router, prompts, events } = this.deps;
    const input = firstUserText.slice(0, TITLE_INPUT_LENGTH);
    const prompt = await prompts.title();
    const route = router.route('title');
    let title: string;
    try {
      const reply = await oneShot({
        route,
        system: prompt.systemPrompt,
        prompt: input,
        signal: this.abort.signal,
        timeoutMs: TITLE_TIMEOUT_MS,
      });
      title = cleanTitle(reply) ?? fallbackTitle(firstUserText);
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.logger.warn('title model failed, using fallback', { conversationId, message: errorMessage(error) });
      title = fallbackTitle(firstUserText);
    }
    const applied = await storage.conversations.setTitleIfUntitled(conversationId, title);
    if (!applied) return;
    const record = await storage.conversations.get(conversationId);
    if (!record) return;
    events.publish(conversationId, {
      type: 'conversation_updated',
      conversation: {
        id: record.id,
        title: record.title?.trim() || DEFAULT_CONVERSATION_TITLE,
        updatedAt: record.lastMessageAt ?? record.updatedAt,
      },
    });
  }
}

export function createTitleService(deps: TitleServiceDeps): TitleService {
  return new StorageTitleService(deps);
}
