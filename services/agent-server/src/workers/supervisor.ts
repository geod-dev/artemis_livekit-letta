import { notImplemented } from '@artemis/core';
import type { WorkspaceProcess } from '@artemis/workspace';
import type { CommandTaskWorker } from './command-task-worker.ts';
import type { MainAgentWorker } from './main-agent-worker.ts';
import type { SubagentTaskWorker } from './subagent-task-worker.ts';
import type { SubagentSpec } from './types.ts';

/**
 * Owns every live worker. Main agent workers live in a `KeyedRegistry`
 * (idle 120 s, sweep every 15 s); a main worker is active while it runs or
 * queues a turn, while its conversation has a running task worker, or while a
 * call is active. Task workers are tracked by task id and removed when their
 * outcome settles.
 *
 * Boot recovery (`recover()`): running turns -> failed('interrupted by restart'),
 * running tool calls -> cancelled, inflight updates -> reverted, running tasks ->
 * failed with report "Interrupted by a server restart" (creating their updates).
 */
export class WorkerSupervisor {
  /** Get or spawn (respawn) the conversation's main worker. */
  mainAgent(_conversationId: string): Promise<MainAgentWorker> {
    return notImplemented('WorkerSupervisor.mainAgent');
  }

  peekMainAgent(_conversationId: string): MainAgentWorker | undefined {
    return notImplemented('WorkerSupervisor.peekMainAgent');
  }

  startSubagent(_taskId: string, _spec: SubagentSpec): Promise<SubagentTaskWorker> {
    return notImplemented('WorkerSupervisor.startSubagent');
  }

  adoptCommand(_input: {
    taskId: string;
    conversationId: string;
    process: WorkspaceProcess;
    outputPath: string;
  }): Promise<CommandTaskWorker> {
    return notImplemented('WorkerSupervisor.adoptCommand');
  }

  stopTask(_taskId: string, _reason: string): Promise<boolean> {
    return notImplemented('WorkerSupervisor.stopTask');
  }

  /** Any running task worker for the conversation. */
  hasActiveTasks(_conversationId: string): boolean {
    return notImplemented('WorkerSupervisor.hasActiveTasks');
  }

  recover(): Promise<void> {
    return notImplemented('WorkerSupervisor.recover');
  }

  start(): void {
    notImplemented('WorkerSupervisor.start');
  }

  shutdown(): Promise<void> {
    return notImplemented('WorkerSupervisor.shutdown');
  }
}
