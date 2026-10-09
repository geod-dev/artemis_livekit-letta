import { readFileSync } from 'node:fs';
import { config } from './config';
import { assistant, letta } from './letta';
import { cleanTitle } from './title-text';

export { fallbackTitle } from './title-text';

const TITLE_TIMEOUT_MS = 20_000;
const TITLE_PROMPT = new URL('../../prompts/title.md', import.meta.url);

/**
 * A one-shot, stateless Letta subagent on the fast model: it names the
 * conversation and touches neither the conversation nor the assistant's memory.
 */
export async function generateTitle(firstMessage: string): Promise<string> {
  const { agentId } = await assistant();
  const query = letta().query({
    prompt: firstMessage.slice(0, 1000),
    options: {
      model: config.models.fast.handle,
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
