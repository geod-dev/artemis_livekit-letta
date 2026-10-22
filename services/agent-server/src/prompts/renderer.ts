import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '@artemis/llm';

/**
 * Renders prompt templates from `services/agent-server/prompts/` with
 * `{{name}}`, `{{workspace}}`, `{{conversation_id}}`, `{{timezone}}`,
 * `{{task_id}}`, `{{mcp_tools}}` (subagents only). Templates are read on each
 * render (dev edits apply to NEW conversations only: rendered prompts are frozen).
 */
export interface RenderedPrompt {
  templateId: string;
  templateHash: string;
  systemPrompt: string;
}

export class PromptRenderer {
  constructor(readonly promptsDir: string) {}

  /** Main agent system prompt, frozen into the conversation's snapshot at creation. */
  async system(vars: { name: string; workspace: string; conversationId: string; timezone: string }): Promise<RenderedPrompt> {
    const source = await this.read('system.md');
    return {
      templateId: 'system',
      templateHash: sha256(source),
      systemPrompt: fill(source, {
        name: vars.name,
        workspace: vars.workspace,
        conversation_id: vars.conversationId,
        timezone: vars.timezone,
      }),
    };
  }

  /** Subagent system prompt: definition body + shared worker rules + MCP tool list. */
  async subagent(vars: {
    definition: string;
    name: string;
    workspace: string;
    conversationId: string;
    taskId: string;
    mcpTools: string;
  }): Promise<RenderedPrompt> {
    const rules = await this.read('worker-rules.md');
    const source = `${vars.definition.trimEnd()}\n\n${rules.trimEnd()}`;
    return {
      templateId: `agent:${vars.name}`,
      templateHash: sha256(source),
      systemPrompt: fill(source, {
        workspace: vars.workspace,
        conversation_id: vars.conversationId,
        task_id: vars.taskId,
        mcp_tools: vars.mcpTools,
      }),
    };
  }

  async title(): Promise<RenderedPrompt> {
    const source = await this.read('title.md');
    return { templateId: 'title', templateHash: sha256(source), systemPrompt: source.trim() };
  }

  private read(file: string): Promise<string> {
    return readFile(join(this.promptsDir, file), 'utf8');
  }
}

/** What gets frozen per conversation / task. */
export interface PromptSnapshot extends RenderedPrompt {
  tools: ToolDefinition[];
}

/** Replaces `{{key}}` for known keys; unknown placeholders are kept verbatim. Trailing whitespace is dropped. */
function fill(source: string, values: Record<string, string>): string {
  return source
    .trimEnd()
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}
