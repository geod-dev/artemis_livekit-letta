import { notImplemented } from '@artemis/core';
import type { ConversationTask } from '@artemis/contracts/chat-types';
import type { CommandHandoff } from '@artemis/tools/workspace-tools';
import type { SubagentSpec } from '../workers/types.ts';

/**
 * Task lifecycle facade used by tools and the API. Creates `tasks` rows,
 * asks the supervisor for workers, publishes `task` SSE events, and projects
 * `TaskRecord` -> `ConversationTask`. Implements the bash `CommandHandoff`.
 */
export abstract class TaskService implements CommandHandoff {
  abstract adopt(input: Parameters<CommandHandoff['adopt']>[0]): ReturnType<CommandHandoff['adopt']>;

  /** Start a subagent in the background (main agent) -> task id. */
  abstract startSubagent(spec: SubagentSpec): Promise<{ taskId: string }>;

  /** Run a subagent and wait for its report (synchronous policy, nested). */
  abstract runSubagent(spec: SubagentSpec, signal: AbortSignal): Promise<{ taskId: string; report: string; status: ConversationTask['status'] }>;

  abstract list(conversationId: string): Promise<ConversationTask[]>;
  abstract get(conversationId: string, taskId: string): Promise<ConversationTask | null>;
  /** Stop a running task (ends `cancelled`); false if not running. */
  abstract stop(conversationId: string, taskId: string): Promise<boolean>;
}

export function createTaskService(): TaskService {
  return notImplemented('createTaskService');
}
