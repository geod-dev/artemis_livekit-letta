import type { Clock } from '@artemis/core';
import {
  MemoryStore,
  type MemoryFact,
  type RecallRequest,
  type RecallResult,
  type RetainRequest,
} from '@artemis/memory';
import type { Storage, TurnRecord } from '@artemis/storage';

/** Manual clock: timers fire only when `advance` moves time past them. */
export class FakeClock implements Clock {
  private current = Date.parse('2026-10-22T10:00:00.000Z');
  private readonly timers: Array<{ at: number; fn: () => void; every: number | null; cancelled: boolean }> = [];

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    return this.schedule(fn, ms, null);
  }

  setInterval(fn: () => void, ms: number): { cancel(): void } {
    return this.schedule(fn, ms, ms);
  }

  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.current = due.at;
      if (due.every === null) due.cancelled = true;
      else due.at += due.every;
      due.fn();
    }
    this.current = target;
  }

  private schedule(fn: () => void, ms: number, every: number | null): { cancel(): void } {
    const timer = { at: this.current + ms, fn, every, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => (timer.cancelled = true) };
  }
}

/** Lets pending promise continuations run (several macrotask turns). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** In-memory `MemoryStore` with scriptable retain failures and recall behaviour. */
export class FakeMemoryStore extends MemoryStore {
  readonly retains: RetainRequest[] = [];
  readonly recalls: RecallRequest[] = [];
  facts: MemoryFact[] = [];
  retainFailures = 0;
  /** `hang` never answers (until the caller aborts). */
  recallMode: 'facts' | 'hang' = 'facts';

  async ensureReady(): Promise<void> {}

  async retain(request: RetainRequest): Promise<{ operationId: string }> {
    if (this.retainFailures > 0) {
      this.retainFailures -= 1;
      throw new Error('hindsight unavailable');
    }
    this.retains.push(request);
    return { operationId: request.operationId };
  }

  async recall(request: RecallRequest, signal?: AbortSignal): Promise<RecallResult> {
    this.recalls.push(request);
    if (this.recallMode === 'hang') {
      return new Promise<RecallResult>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted by caller')));
      });
    }
    return { facts: this.facts };
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}

export function fact(id: string, text: string): MemoryFact {
  return { id, text, type: 'world' };
}

export async function seedConversation(storage: Storage, id: string): Promise<void> {
  await storage.conversations.create(
    { id, title: null, titleSource: null },
    { systemPrompt: 'system', tools: [], templateId: 'system', templateHash: 'hash' }
  );
}

/** One completed turn: a user message and, unless `kind` is `update`, the assistant reply. */
export async function seedTurn(
  storage: Storage,
  input: {
    id: string;
    conversationId: string;
    kind?: 'user' | 'update';
    modality?: 'text' | 'voice';
    effort?: TurnRecord['effort'];
    text: string;
    reply?: string;
    status?: 'completed' | 'failed';
  }
): Promise<TurnRecord> {
  const kind = input.kind ?? 'user';
  const startedAt = new Date(Date.parse('2026-10-22T10:00:00.000Z')).toISOString();
  await storage.turns.create({
    id: input.id,
    conversationId: input.conversationId,
    kind,
    modality: input.modality ?? 'text',
    mode: input.modality === 'voice' ? 'voice-short' : 'text',
    effort: input.effort ?? null,
    status: 'running',
    clientMessageId: null,
    model: null,
    startedAt,
  });
  await storage.messages.append({
    id: `${input.id}-user`,
    conversationId: input.conversationId,
    taskId: null,
    turnId: input.id,
    role: 'user',
    content: [{ type: 'text', text: input.text }],
    envelope: null,
    provider: null,
    model: null,
    providerMessageId: null,
    stopReason: null,
    usage: null,
    timings: null,
  });
  if (input.reply !== undefined) {
    await storage.messages.append({
      id: `${input.id}-assistant`,
      conversationId: input.conversationId,
      taskId: null,
      turnId: input.id,
      role: 'assistant',
      content: [{ type: 'text', text: input.reply }],
      envelope: null,
      provider: null,
      model: null,
      providerMessageId: null,
      stopReason: 'end_turn',
      usage: null,
      timings: null,
    });
  }
  await storage.turns.finish(input.id, {
    status: input.status ?? 'completed',
    error: null,
    usage: null,
    model: null,
    endedAt: new Date(Date.parse(startedAt) + 1000).toISOString(),
  });
  const turn = await storage.turns.get(input.id);
  if (!turn) throw new Error(`turn ${input.id} not stored`);
  return turn;
}
