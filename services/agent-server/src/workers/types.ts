import type { ChatAttachment, Modality, TextEffort, TurnMode } from '@artemis/contracts/chat-types';
import type { BackgroundUpdateRecord, TaskRecord } from '@artemis/storage';

export type WorkerKind = 'main-agent' | 'subagent-task' | 'command-task';

/**
 * spawning -> idle <-> busy -> stopping -> stopped (main agent)
 * spawning -> busy -> stopping -> stopped           (task workers: die at task end)
 * `failed` is terminal (spawn error); the supervisor drops failed workers.
 */
export type WorkerState = 'spawning' | 'idle' | 'busy' | 'stopping' | 'stopped' | 'failed';

/** One turn asked of a main agent worker. */
export interface TurnSubmission {
  kind: 'user' | 'update';
  modality: Modality;
  mode: TurnMode;
  /** Text only; voice uses the voice route. */
  effort?: TextEffort;
  /** The user's words; '' for update turns. */
  text: string;
  attachments?: ChatAttachment[];
  clientMessageId?: string;
  /**
   * Updates claimed for this turn by the caller (spoken voice updates).
   * Text/update turns claim every `held` update themselves when they start.
   */
  updates?: BackgroundUpdateRecord[];
  deliveryToken?: string;
  /** Abort (voice interruption, HTTP disconnect). `cancel()` aborts too. */
  signal?: AbortSignal;
  /** Streams assistant text (voice endpoints). Voice markers are already stripped. */
  onText?: (delta: string) => void;
}

export interface TurnOutcome {
  turnId: string;
  status: 'completed' | 'failed' | 'cancelled';
  text: string;
  error?: string;
  /** Voice: what the trailing marker asked for. */
  callState?: 'listen' | 'done' | null;
}

/** Handle returned as soon as a turn is queued. */
export interface TurnHandle {
  turnId: string;
  /** Resolves when the turn ends (never rejects). */
  done: Promise<TurnOutcome>;
}

export interface TaskOutcome {
  task: TaskRecord;
}

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
