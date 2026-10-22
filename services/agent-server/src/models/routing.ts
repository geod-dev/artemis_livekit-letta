import { notImplemented } from '@artemis/core';
import type { ModelRoute, ProviderRegistry } from '@artemis/llm';
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
 * Never sends temperature/top_p/top_k.
 */
export type RouteKind = 'assistant-text' | 'assistant-voice' | 'update' | 'worker' | 'title';

export interface ModelRouter {
  route(kind: RouteKind, options?: { effort?: TextEffort; modality?: 'text' | 'voice' }): ModelRoute;
}

export function createModelRouter(_config: AgentServerConfig, _providers: ProviderRegistry): ModelRouter {
  return notImplemented('createModelRouter');
}
