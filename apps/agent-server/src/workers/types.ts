import type { TaskRecord } from '@artemis/storage';

export type { SubagentSpec } from '../tools/task-port.ts';

export type WorkerKind = 'main-agent' | 'subagent-task' | 'command-task';

/**
 * spawning -> idle <-> busy -> stopping -> stopped (main agent)
 * spawning -> busy -> stopping -> stopped           (task workers: die at task end)
 * `failed` is terminal (spawn error); the supervisor drops failed workers.
 */
export type WorkerState = 'spawning' | 'idle' | 'busy' | 'stopping' | 'stopped' | 'failed';

export interface TaskOutcome {
  task: TaskRecord;
}

/**
 * `background`: the outcome becomes a background update for the main agent.
 * `synchronous`: a nested run whose report is returned to the calling tool.
 */
export type SubagentStartMode = 'background' | 'synchronous';
