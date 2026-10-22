import { LlmError, type ModelRoute } from '@artemis/llm';

/**
 * A single tool-less completion (titles, summaries): system + one user text -> text.
 * Rejects on abort or timeout (`signal.reason`), on refusals and on provider errors.
 */
export async function oneShot(input: {
  route: ModelRoute;
  system: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const signal = combineSignals(input.signal, input.timeoutMs);
  const response = await input.route.provider.complete(
    {
      model: input.route.model,
      system: input.system,
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
      maxTokens: input.route.maxTokens,
      thinking: input.route.thinking,
      showReasoning: input.route.showReasoning,
      effort: input.route.effort,
      cache: input.route.cache,
      compaction: input.route.compaction,
    },
    signal
  );

  if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
  if (response.stopReason === 'aborted') throw new Error('Aborted');
  if (response.stopReason === 'refusal') throw new LlmError('refusal', 'The model refused the request', false);
  if (response.stopReason === 'error') throw new LlmError('unknown', 'The model call failed', true);

  return response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  if (signal && timeout) return AbortSignal.any([signal, timeout]);
  return signal ?? timeout;
}
