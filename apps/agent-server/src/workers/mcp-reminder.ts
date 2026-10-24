import { type Logger, errorMessage } from '@artemis/core';
import { mcpToolsReminder, type McpCatalog } from '@artemis/mcp';
import type { ConversationRecord, Storage } from '@artemis/storage';
import { safely } from './safely.ts';

export interface McpReminderDeps {
  storage: Pick<Storage, 'conversations'>;
  catalog: McpCatalog;
  logger: Logger;
}

type ToolNames = Awaited<ReturnType<McpCatalog['names']>>;

/** The MCP reminder of one turn, and the tool names it was planned from. */
export interface McpReminderPlan {
  reminder?: string;
  /** The tool names this turn shows the model; undefined when the catalog was unavailable. */
  names?: ToolNames;
}

/**
 * Tells the model which MCP tools were added or removed since the conversation last
 * saw them. The snapshot of shown names is written by `remember`, after the turn
 * completed, so a turn that fails does not hide the change from the next one.
 */
export class McpReminder {
  constructor(private readonly deps: McpReminderDeps) {}

  async plan(conversationId: string, conversation: ConversationRecord): Promise<McpReminderPlan> {
    const { catalog, logger } = this.deps;
    try {
      const names = await catalog.names();
      const reminder = mcpToolsReminder(names, conversation.mcpToolNamesShown);
      return { ...(reminder ? { reminder } : {}), names };
    } catch (error) {
      logger.warn('MCP tool list unavailable for this turn', { conversationId, error: errorMessage(error) });
      return {};
    }
  }

  /** Stores the names the completed turn showed. */
  async remember(conversationId: string, names: ToolNames): Promise<void> {
    const { storage, logger } = this.deps;
    await safely(logger, 'MCP tool snapshot', () => storage.conversations.setMcpToolNamesShown(conversationId, names));
  }
}
