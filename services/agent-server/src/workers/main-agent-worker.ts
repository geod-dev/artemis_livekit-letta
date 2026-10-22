import { notImplemented } from '@artemis/core';
import type { TurnHandle, TurnSubmission } from './types.ts';
import { Worker } from './worker.ts';

/**
 * The generating loop of one conversation. Spawned lazily by the supervisor on
 * the first need (message, warm-up, waking update), reaped after
 * `idleTimeoutMs` (2 min) without activity; a running turn, queued turns, an
 * active call or any running task of the conversation count as activity.
 *
 * `start()` loads: conversation + frozen prompt snapshot, the transcript
 * (`messages` where task_id is null), MCP names last shown. Turns are
 * serialized by a `SerialScheduler` (max pending 32 -> `BusyError`).
 *
 * One turn (see architecture.md#turn-loop):
 *  1. persist turn (running) + publish `turn_start`; record last-active conversation
 *     (memory coordinator may flush the previous conversation);
 *  2. claim held updates (text/update turns) -> inflight;
 *  3. in parallel: recall memories (budget by modality/effort, timeout), MCP reminder diff,
 *     resolve image attachments through the WorkspaceTransport;
 *  4. render + persist the user message (content + envelope); publish `message` echo;
 *  5. AgentLoop with the route for the turn; stream events to the hub, persist assistant
 *     messages, tool calls and tool results as they complete;
 *  6. finish: turn status/usage, complete or roll back deliveries, `context_usage`,
 *     `turn_end`, memory coordinator `turnCompleted`, title request on the first user turn.
 */
export class MainAgentWorker extends Worker {
  readonly kind = 'main-agent' as const;

  constructor(readonly conversationId: string) {
    super();
  }

  get id(): string {
    return this.conversationId;
  }

  start(): Promise<void> {
    return notImplemented('MainAgentWorker.start');
  }

  /** Queue a turn; throws `BusyError` when the queue is full. */
  submit(_turn: TurnSubmission): TurnHandle {
    return notImplemented('MainAgentWorker.submit');
  }

  /** Abort the running turn (queued turns stay). */
  cancel(): boolean {
    return notImplemented('MainAgentWorker.cancel');
  }

  get busy(): boolean {
    return notImplemented('MainAgentWorker.busy');
  }

  isActive(_now: number): boolean {
    return notImplemented('MainAgentWorker.isActive');
  }

  dispose(_reason: string): Promise<void> {
    return notImplemented('MainAgentWorker.dispose');
  }
}
