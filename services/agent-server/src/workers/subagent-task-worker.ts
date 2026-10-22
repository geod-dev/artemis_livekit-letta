import { notImplemented } from '@artemis/core';
import { TaskWorker } from './task-worker.ts';
import type { SubagentSpec, TaskOutcome } from './types.ts';

/**
 * A subagent run: AgentLoop on the `worker` route, its own transcript
 * (`messages.task_id = taskId`; a resumed task first replays the previous
 * task's transcript), its own frozen prompt snapshot (definition + worker rules
 * + MCP tool list), the full toolset under the `synchronous` policy.
 * Report = final assistant text; `NEEDS USER INPUT:` sets `needsInput`.
 * Streams nothing to the conversation SSE except `task` status events.
 */
export class SubagentTaskWorker extends TaskWorker {
  readonly kind = 'subagent-task' as const;

  constructor(
    readonly taskId: string,
    readonly spec: SubagentSpec
  ) {
    super();
  }

  get conversationId(): string {
    return this.spec.conversationId;
  }

  get outcome(): Promise<TaskOutcome> {
    return notImplemented('SubagentTaskWorker.outcome');
  }

  start(): Promise<void> {
    return notImplemented('SubagentTaskWorker.start');
  }

  stop(_reason: string): Promise<void> {
    return notImplemented('SubagentTaskWorker.stop');
  }

  dispose(_reason: string): Promise<void> {
    return notImplemented('SubagentTaskWorker.dispose');
  }
}
