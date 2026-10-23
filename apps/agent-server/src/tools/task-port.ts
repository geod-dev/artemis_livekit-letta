import type { ConversationTask, TurnMode } from '@artemis/contracts/chat-types';
import type { CommandHandoff } from '@artemis/tools/workspace-tools';

/** What a subagent task is started with. */
export interface SubagentSpec {
  conversationId: string;
  subagentType: string;
  title: string;
  prompt: string;
  originMode: TurnMode;
  originTurnId: string | null;
  originToolCallId: string | null;
  parentTaskId: string | null;
  resumedFromTaskId: string | null;
  depth: number;
}

/**
 * The task operations the agent tools call. Tools depend on this port only;
 * the task service in tasks/ implements it and is wired in by the runtime.
 * `adopt` comes from the workspace bash tool's `CommandHandoff`.
 */
export interface TaskPort extends CommandHandoff {
  /** Start a subagent in the background (main agent) -> task id. */
  startSubagent(spec: SubagentSpec): Promise<{ taskId: string }>;
  /** Run a subagent and wait for its report (synchronous policy, nested). */
  runSubagent(
    spec: SubagentSpec,
    signal: AbortSignal
  ): Promise<{ taskId: string; report: string; status: ConversationTask['status'] }>;
  list(conversationId: string): Promise<ConversationTask[]>;
  get(conversationId: string, taskId: string): Promise<ConversationTask | null>;
  /** Stop a running task (ends `cancelled`); false if not running. */
  stop(conversationId: string, taskId: string): Promise<boolean>;
}
