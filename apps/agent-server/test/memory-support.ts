import type { MemoryFact } from '@artemis/memory';
import type { Storage, TurnRecord } from '@artemis/storage';

/** Lets pending promise continuations run (several macrotask turns). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
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
