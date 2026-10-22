import type { WorkspaceProcess } from '@artemis/workspace';
import type { ToolContext } from '../context.ts';

/**
 * Port the bash tool uses to hand a still-running process to a
 * `CommandTaskWorker` (implemented by the agent-server's task service).
 */
export interface CommandHandoff {
  /**
   * Adopt `process` as a background command task of the calling conversation.
   * `cwd` is the workspace-relative directory the command runs in (`.` for the root).
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
