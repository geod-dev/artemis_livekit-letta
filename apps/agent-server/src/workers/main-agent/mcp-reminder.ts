import { type Clock, type Logger, errorMessage } from '@artemis/core';
import { mcpToolsReminder, type McpCatalog } from '@artemis/mcp';
import type { ConversationRecord, Storage } from '@artemis/storage';
import { safely } from '../safely.ts';
import { runWithTimeout } from '../../util/async.ts';

/**
 * Longest a turn or a subagent start waits for the MCP catalog. A refresh past this
 * bound keeps running inside the catalog (its next read sees the result); the caller
 * proceeds without the tool list for this turn.
 */
export const MCP_CATALOG_WAIT_MS = 3_000;

export interface McpReminderDeps {
  storage: Pick<Storage, 'conversations'>;
  catalog: McpCatalog;
  clock: Clock;
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

  /** Plans the reminder under `signal` (the turn's); the catalog wait is bounded by `MCP_CATALOG_WAIT_MS`. */
  async plan(conversationId: string, conversation: ConversationRecord, signal: AbortSignal): Promise<McpReminderPlan> {
    const { catalog, clock, logger } = this.deps;
    try {
      const names = await runWithTimeout({ clock, timeoutMs: MCP_CATALOG_WAIT_MS, parent: signal }, () => catalog.names());
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
