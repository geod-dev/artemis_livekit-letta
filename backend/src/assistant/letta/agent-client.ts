import {
  LettaAgentClient,
  type LettaCodeSocketConstructor,
} from '@letta-ai/letta-agent-sdk';
import WebSocket from 'ws';
import type { CatalogTool } from '../../mcp-bridge/catalog';
import { config } from '../config';
import { assistantModelSettings } from './model-adapter.ts';
import { initialHuman, initialPersona, systemPrompt } from '../prompts';

interface AssistantIdentity {
  agentId: string;
  /** Explicitly configured internal conversation identity, if present. */
  defaultConversationId: string | null;
}

let lettaClient: LettaAgentClient | undefined;
let identity: Promise<AssistantIdentity> | undefined;
let mcpInventory: () => readonly CatalogTool[] | Promise<readonly CatalogTool[]> = () => [];

export function configureMcpInventory(
  provider: () => readonly CatalogTool[] | Promise<readonly CatalogTool[]>
): void {
  mcpInventory = provider;
}

export async function getMcpToolNames(): Promise<string[]> {
  return (await mcpInventory()).map((tool) => tool.qualified);
}

function currentSystemPrompt(): string {
  return systemPrompt(config.assistant.name, config.workspace.agentDir);
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
    if (event === 'message' && isSubagentTranscriptFrame(args[0])) return false;
    return super.emit(event, ...args);
  }
}

const assistantSocket: LettaCodeSocketConstructor = AssistantSocket;

export function isSubagentTranscriptFrame(data: unknown): boolean {
  const text = String(data);
  if (!text.includes('"subagent_id"')) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && typeof parsed.subagent_id === 'string';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One App Server client per process (it pools the management connection). */
export function letta(): LettaAgentClient {
  return (lettaClient ??= new LettaAgentClient({
    backend: 'remote',
    url: config.letta.url,
    authToken: config.letta.token,
    // `ws` lets the SDK send the bearer token as a header.
    WebSocket: assistantSocket,
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
  // Refresh persisted agents as well as newly created ones.
  if (existing[0]) {
    await client.agents.update(existing[0].id, {
      system: prompt,
      model: config.model.handle,
      modelSettings: assistantModelSettings('text'),
    });
  }
  const agentId =
    existing[0]?.id ??
    (await client.createAgent({
      name: config.letta.agentName,
      description: `${config.assistant.name}, the personal assistant`,
      model: config.model.handle,
      systemPrompt: prompt,
      persona: initialPersona(config.assistant.name),
      human: initialHuman,
      baseTools: [],
      skillSources: [],
      dreaming: { trigger: 'step-count', stepCount: config.memory.reflectionStepCount },
    }));
  // Default-thread identity is configuration, never a guess from whichever
  // user conversation happens to sort first.
  return { agentId, defaultConversationId: config.letta.defaultConversationId ?? null };
}
