import type { ModelRoute, ProviderRegistry, Effort } from '@artemis/llm';
import type { TextEffort } from '@artemis/contracts/chat-types';
import type { AgentServerConfig } from '../config.ts';

/**
 * Model routing (port of infrastructure/letta/patching/model-requests.mjs and
 * assistant/letta/model-adapter.ts):
 * - `assistant-text`: ASSISTANT_MODEL, thinking adaptive (summaries streamed),
 *   effort = the turn's effort (default medium), cache + compaction on.
 * - `assistant-voice`: ASSISTANT_MODEL, thinking disabled, effort medium.
 * - `update`: like `assistant-text` at effort low (or `assistant-voice` for a spoken update).
 * - `worker`: ASSISTANT_TASK_MODEL, effort high (GLM via Telnyx), never inherits the parent's settings.
 * - `title`: ASSISTANT_TITLE_MODEL, thinking disabled, effort low, small maxTokens.
 * Never sends temperature/top_p/top_k (the providers never take them).
 */
export type RouteKind = 'assistant-text' | 'assistant-voice' | 'update' | 'worker' | 'title';

export interface ModelRouter {
  route(kind: RouteKind, options?: { effort?: TextEffort; modality?: 'text' | 'voice' }): ModelRoute;
}

const TEXT_MAX_TOKENS = 32_000;
const VOICE_MAX_TOKENS = 8_000;
const WORKER_MAX_TOKENS = 32_000;
const TITLE_MAX_TOKENS = 64;

const DEFAULT_TEXT_EFFORT: Effort = 'medium';
const VOICE_EFFORT: Effort = 'medium';
const UPDATE_TEXT_EFFORT: Effort = 'low';
const WORKER_EFFORT: Effort = 'high';
const TITLE_EFFORT: Effort = 'low';

export function createModelRouter(config: AgentServerConfig, providers: ProviderRegistry): ModelRouter {
  const assistant = providers.resolve(config.models.assistant);
  const task = providers.resolve(config.models.task);
  const title = providers.resolve(config.models.title);

  const capped = (
    target: { provider: ModelRoute['provider']; model: string },
    wanted: number
  ): number => Math.min(wanted, target.provider.modelInfo(target.model).maxOutputTokens);

  const claudeRoute = (
    thinking: ModelRoute['thinking'],
    effort: Effort,
    maxTokens: number,
    showReasoning: boolean
  ): ModelRoute => ({
    provider: assistant.provider,
    model: assistant.model,
    thinking,
    effort,
    maxTokens: capped(assistant, maxTokens),
    showReasoning,
    cache: true,
    compaction: true,
  });

  const voiceRoute = () => claudeRoute('disabled', VOICE_EFFORT, VOICE_MAX_TOKENS, false);

  return {
    route(kind, options = {}) {
      switch (kind) {
        case 'assistant-text':
          return claudeRoute('adaptive', options.effort ?? DEFAULT_TEXT_EFFORT, TEXT_MAX_TOKENS, true);
        case 'assistant-voice':
          return voiceRoute();
        case 'update':
          if (options.modality === 'voice') return voiceRoute();
          return claudeRoute('adaptive', options.effort ?? UPDATE_TEXT_EFFORT, TEXT_MAX_TOKENS, true);
        case 'worker':
          return {
            provider: task.provider,
            model: task.model,
            thinking: 'adaptive',
            effort: WORKER_EFFORT,
            maxTokens: capped(task, WORKER_MAX_TOKENS),
            showReasoning: false,
            cache: false,
            compaction: false,
          };
        case 'title':
          return {
            provider: title.provider,
            model: title.model,
            thinking: 'disabled',
            effort: TITLE_EFFORT,
            maxTokens: capped(title, TITLE_MAX_TOKENS),
            showReasoning: false,
            cache: false,
            compaction: false,
          };
      }
    },
  };
}
