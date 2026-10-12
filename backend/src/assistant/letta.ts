import { LettaAgentClient } from '@letta-ai/letta-agent-sdk';
import WebSocket from 'ws';
import type { CatalogTool } from '../mcp-bridge/catalog';
import { config } from './config';
import { mcpSystemContext } from './mcp-context';
import { initialHuman, initialPersona, systemPrompt } from './prompts';

interface AssistantIdentity {
  agentId: string;
  /**
   * The agent's built-in default conversation (created with the agent, so the
   * oldest one). Updating its model changes the agent's model, and it is not a
   * chat the user started, so it is kept out of the chat list.
   */
  defaultConversationId: string | null;
}

let lettaClient: LettaAgentClient | undefined;
let identity: Promise<AssistantIdentity> | undefined;
let inventory: () => readonly CatalogTool[] = () => [];
let appliedPrompt: string | null = null;
let promptChain: Promise<unknown> = Promise.resolve();

export function configureMcpInventory(provider: () => readonly CatalogTool[]): void {
  inventory = provider;
}

function currentSystemPrompt(): string {
  return (
    systemPrompt(config.assistant.name, config.workspace.agentDir) + mcpSystemContext(inventory())
  );
}

/** The local backend recompiles existing conversations when the raw system prompt changes. */
export function syncAssistantSystemPrompt(): Promise<void> {
  const run = promptChain.then(async () => {
    const { agentId } = await assistant();
    const prompt = currentSystemPrompt();
    if (prompt === appliedPrompt) return;
    await letta().agents.update(agentId, { system: prompt });
    appliedPrompt = prompt;
  });
  promptChain = run.catch(() => {});
  return run;
}

/**
 * Letta streams the transcript of background workers (frames with a top-level
 * `subagent_id`) to the sessions of the conversation that started them, and
 * the SDK attributes those frames to whichever turn is running: a worker's
 * text would become part of a reply. The gateway does not use them, so they
 * are dropped at the socket. Worker state updates are not affected.
 */
class AssistantSocket extends WebSocket {
  emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'message' && isWorkerFrame(args[0])) return false;
    return super.emit(event, ...args);
  }
}

function isWorkerFrame(data: unknown): boolean {
  const text = String(data);
  if (!text.includes('"subagent_id"')) return false;
  try {
    return typeof (JSON.parse(text) as { subagent_id?: unknown }).subagent_id === 'string';
  } catch {
    return false;
  }
}

/** One App Server client per process (it pools the management connection). */
export function letta(): LettaAgentClient {
  return (lettaClient ??= new LettaAgentClient({
    backend: 'remote',
    url: config.letta.url,
    authToken: config.letta.token,
    // `ws` lets the SDK send the bearer token as a header.
    WebSocket: AssistantSocket as never,
  }));
}

/**
 * Find the single persistent assistant by name, creating it on first run.
 * Memory starts with persona/human files. Sessions supply MemFS file tools for
 * direct updates and Letta's native Agent tool for background work, including
 * incidental memory upkeep.
 */
export function assistant(): Promise<AssistantIdentity> {
  identity ??= resolveAssistant().catch((error) => {
    identity = undefined; // retry on next call (e.g. Letta not up yet)
    throw error;
  });
  return identity;
}

async function resolveAssistant(): Promise<AssistantIdentity> {
  const client = letta();
  const prompt = currentSystemPrompt();
  const existing = await client.agents.list({ name: config.letta.agentName, limit: 1 });
  // The system prompt is set at creation; keep an existing agent on the current one.
  if (existing[0] && existing[0].system !== prompt) {
    await client.agents.update(existing[0].id, { system: prompt });
  }
  const agentId =
    existing[0]?.id ??
    (await client.createAgent({
      name: config.letta.agentName,
      description: `${config.assistant.name}, the personal assistant`,
      model: config.models.smart.handle,
      systemPrompt: prompt,
      persona: initialPersona(config.assistant.name),
      human: initialHuman,
      baseTools: [],
      skillSources: [],
      dreaming: { trigger: 'step-count', stepCount: config.memory.reflectionStepCount },
    }));
  appliedPrompt = prompt;

  // Sort locally: the local backend does not honour every list ordering.
  const conversations = await client.conversations.list({ agentId, limit: 1000 });
  const oldest = conversations.reduce<(typeof conversations)[number] | undefined>(
    (min, c) =>
      !min || Date.parse(c.created_at ?? '') < Date.parse(min.created_at ?? '') ? c : min,
    undefined
  );
  return { agentId, defaultConversationId: oldest?.id ?? null };
}
