import type { Logger } from '@artemis/core';
import type { WorkspaceAccessPolicy, WorkspaceTransport } from '@artemis/workspace';

/**
 * How tools run:
 * - `interactive` (main agent): long commands hand off to the background
 *   after `backgroundAfterMs`; `run_agent` starts a background task.
 * - `synchronous` (subagent workers): everything finishes before the tool
 *   returns (no handoff, `run_in_background` refused, nested `run_agent` awaited).
 */
export type ExecutionPolicy = 'interactive' | 'synchronous';

/** Generic context every tool receives for one call. */
export interface ToolContext {
  conversationId: string;
  /** Set when the caller is a task worker (subagent). */
  taskId: string | null;
  turnId: string | null;
  toolCallId: string;
  signal: AbortSignal;
  policy: ExecutionPolicy;
  workspace: WorkspaceTransport;
  access: WorkspaceAccessPolicy;
  logger: Logger;
  /** Live progress for the UI (e.g. command output lines); optional for tools. */
  progress?: (text: string) => void;
}
