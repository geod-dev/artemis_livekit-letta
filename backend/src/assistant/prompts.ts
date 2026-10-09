import { readFileSync } from 'node:fs';

/**
 * Operating instructions for the single persistent assistant, written in
 * `prompts/system.md` with `{{name}}` and `{{workspace}}` placeholders. Identity
 * and user knowledge live in Letta memory (persona/human), which Letta compiles
 * into the system prompt on every turn; this prompt explains the environment
 * and the operating model shared by text and voice. Tool descriptions state
 * what tools do; when to use them is decided here.
 *
 * The prompt is the agent's, shared by all conversations, so the current
 * conversation id is given through the shell (Letta sets `CONVERSATION_ID`
 * for every command).
 */
const SYSTEM_PROMPT = new URL('../../prompts/system.md', import.meta.url);

/** Read on each call, so an edited file is used without a code change. */
export function systemPrompt(name: string, workspace: string): string {
  return readFileSync(SYSTEM_PROMPT, 'utf8')
    .trimEnd()
    .replaceAll('{{name}}', name)
    .replaceAll('{{workspace}}', workspace);
}

export const initialPersona = (name: string) =>
  `My name is ${name}. I'm the smartest friend of the person I help: warm, quick, a bit playful, and great at juggling many things at once. I keep track of what matters to them and get things done with minimal fuss.`;

export const initialHuman = `Nothing is known about the user yet.`;
