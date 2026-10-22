import { notImplemented } from '@artemis/core';
import type { WorkspaceProcess } from '@artemis/workspace';
import type { ToolContext } from '../context.ts';
import type { AnyTool } from '../tool.ts';

/**
 * Port the bash tool uses to hand a still-running process to a
 * `CommandTaskWorker` (implemented by the agent-server's task service).
 */
export interface CommandHandoff {
  /**
   * Adopt `process` as a background command task of the calling conversation.
   * `reason`: `requested` (`run_in_background: true`) or `handoff` (outlived the delay).
   */
  adopt(input: {
    process: WorkspaceProcess;
    command: string;
    description: string;
    cwd: string;
    reason: 'requested' | 'handoff';
    context: ToolContext;
  }): Promise<{ taskId: string; outputPath: string }>;
}

export interface WorkspaceToolsOptions {
  handoff: CommandHandoff;
  /** Foreground -> background delay in `interactive` policy (default `DEFAULT_BACKGROUND_AFTER_MS`). */
  backgroundAfterMs?: number;
}

/**
 * The default workspace tools, in `TOOL_NAMES` order:
 * read_file, write_file, edit_file, delete_file, list_files, search_files, bash.
 * Writes respect `context.access.readOnlyPrefixes` (`data/`).
 *
 * bash (`{command, description, timeout_ms?, run_in_background?}`):
 * - interactive: spawn; race(exit, `backgroundAfterMs`, abort). Exit -> result with
 *   exit code + output (head 2 000 chars + log path when > 30 000). Timer -> `handoff.adopt`
 *   and return "still running as task <id>; you will get a background update" with
 *   `task: {relation:'backgrounded'}`. `run_in_background` -> adopt immediately.
 *   Abort -> kill the process, error result "Interrupted by user".
 * - synchronous: wait up to `timeout_ms` (default 120 s, max 600 s), never hand off,
 *   refuse `run_in_background`.
 */
export function createWorkspaceTools(_options: WorkspaceToolsOptions): AnyTool<ToolContext>[] {
  return notImplemented('createWorkspaceTools');
}
