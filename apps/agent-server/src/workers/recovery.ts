import { type Logger, uuid } from '@artemis/core';
import type { Storage } from '@artemis/storage';

const RESTART_REASON = 'interrupted by restart';
const RESTART_TEXT = 'Interrupted by a server restart';

export interface RecoveryDeps {
  storage: Storage;
  logger: Logger;
  /** Ends one running task as failed, with its update (the supervisor owns the task lifecycle). */
  failTask(taskId: string): Promise<void>;
}

/**
 * Boot recovery, run before the server accepts requests: running turns -> failed (with synthetic
 * results for their dangling tool uses), running tool calls -> cancelled, inflight updates ->
 * reverted, running tasks -> failed with an update.
 */
export async function recoverAfterRestart({ storage, logger, failTask }: RecoveryDeps): Promise<void> {
  const turnIds = await storage.turns.failRunning(RESTART_REASON);
  for (const turnId of turnIds) {
    const turn = await storage.turns.get(turnId);
    if (turn) await closeDanglingToolUses(storage, turn.conversationId);
  }
  const cancelled = await storage.toolCalls.cancelRunning(RESTART_REASON);
  const reverted = await storage.updates.revertInflight();
  const running = await storage.tasks.listRunning();
  for (const task of running) await failTask(task.id);
  logger.info('recovered after restart', { turns: turnIds.length, toolCalls: cancelled, updates: reverted, tasks: running.length });
}

/** A transcript that ends with tool uses no result was stored for (interrupted turn): answer them as errors. */
async function closeDanglingToolUses(storage: Storage, conversationId: string): Promise<void> {
  const transcript = await storage.messages.transcript(conversationId, null);
  const last = transcript.at(-1);
  if (!last || last.role !== 'assistant') return;
  const toolUseIds = (last.content as Array<{ type?: string; id?: string }>).flatMap((block) =>
    block.type === 'tool_use' && block.id ? [block.id] : []
  );
  if (toolUseIds.length === 0) return;
  await storage.messages.append({
    id: uuid(),
    conversationId,
    taskId: null,
    turnId: last.turnId,
    role: 'user',
    content: toolUseIds.map((toolUseId) => ({
      type: 'tool_result',
      toolUseId,
      content: [{ type: 'text', text: RESTART_TEXT }],
      isError: true,
    })),
    envelope: null,
    provider: null,
    model: null,
    providerMessageId: null,
    stopReason: null,
    usage: null,
    timings: null,
  });
}
