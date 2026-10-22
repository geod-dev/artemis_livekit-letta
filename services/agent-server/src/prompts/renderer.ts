import { notImplemented } from '@artemis/core';
import type { ToolDefinition } from '@artemis/llm';

/**
 * Renders prompt templates from `services/agent-server/prompts/` with
 * `{{name}}`, `{{workspace}}`, `{{conversation_id}}`, `{{timezone}}`,
 * `{{mcp_tools}}` (subagents only). Templates are read on each render (dev
 * edits apply to NEW conversations only: rendered prompts are frozen).
 */
export interface RenderedPrompt {
  templateId: string;
  templateHash: string;
  systemPrompt: string;
}

export class PromptRenderer {
  constructor(readonly promptsDir: string) {}

  /** Main agent system prompt, frozen into the conversation's snapshot at creation. */
  system(_vars: { name: string; workspace: string; conversationId: string; timezone: string }): Promise<RenderedPrompt> {
    return notImplemented('PromptRenderer.system');
  }

  /** Subagent system prompt: definition body + shared worker rules + MCP tool list. */
  subagent(_vars: {
    definition: string;
    name: string;
    workspace: string;
    conversationId: string;
    taskId: string;
    mcpTools: string;
  }): Promise<RenderedPrompt> {
    return notImplemented('PromptRenderer.subagent');
  }

  title(): Promise<RenderedPrompt> {
    return notImplemented('PromptRenderer.title');
  }
}

/** What gets frozen per conversation / task. */
export interface PromptSnapshot extends RenderedPrompt {
  tools: ToolDefinition[];
}
