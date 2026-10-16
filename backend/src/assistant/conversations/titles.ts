import { readFileSync } from 'node:fs';
import { config } from '../config';
import { assistant, letta } from '../letta/agent-client.ts';
import { cleanTitle } from './title-text.ts';

export { fallbackTitle } from './title-text.ts';

const TITLE_TIMEOUT_MS = 20_000;
const TITLE_PROMPT = new URL('../../../prompts/title.md', import.meta.url);
const titleLocks = new Map<string, Promise<void>>();

async function withTitleLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = titleLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  titleLocks.set(id, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (titleLocks.get(id) === current) titleLocks.delete(id);
  }
}

/** A manual title wins over any title generation already in flight. */
export function renameConversationTitle(id: string, title: string): Promise<Awaited<ReturnType<ReturnType<typeof letta>['conversations']['update']>>> {
  return withTitleLock(id, () => letta().conversations.update(id, { summary: title }));
}

/** Apply an automatic title only while no user title has been set. */
export function renameConversationIfUntitled(id: string, title: string): Promise<Awaited<ReturnType<ReturnType<typeof letta>['conversations']['update']>> | null> {
  return withTitleLock(id, async () => {
    const current = await letta().conversations.retrieve(id);
    if (current.summary?.trim()) return null;
    return letta().conversations.update(id, { summary: title });
  });
}

/**
 * A one-shot, stateless Claude query names the
 * conversation and touches neither the conversation nor the assistant's memory.
 */
export async function generateTitle(firstMessage: string): Promise<string> {
  const { agentId } = await assistant();
  const query = letta().query({
    prompt: firstMessage.slice(0, 1000),
    options: {
      model: config.model.handle,
      system: readFileSync(TITLE_PROMPT, 'utf8').trim(),
      isSubagent: true,
      parentAgentId: agentId,
      name: 'title-subagent',
      skillSources: [],
      toolset: { base: 'none' },
      permissionMode: 'unrestricted',
    },
  });
  const timeout = setTimeout(() => void query.interrupt().catch(() => undefined), TITLE_TIMEOUT_MS);
  try {
    let text = '';
    for await (const message of query) {
      if (message.type === 'assistant') text += message.content;
      if (message.type === 'result') {
        if (!message.success) throw new Error(message.errorCode ?? 'title generation failed');
        return cleanTitle(message.result || text);
      }
    }
    return cleanTitle(text);
  } finally {
    clearTimeout(timeout);
    query.close();
  }
}
