import { notImplemented } from '@artemis/core';
import type { ModelRoute } from '@artemis/llm';

/** A single tool-less completion (titles, summaries): system + one user text -> text. */
export async function oneShot(_input: {
  route: ModelRoute;
  system: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  return notImplemented('oneShot');
}
