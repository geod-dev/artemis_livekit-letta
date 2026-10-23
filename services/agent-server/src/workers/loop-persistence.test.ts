import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LoopEvent } from '@artemis/agent';
import type { ConversationEvent } from '@artemis/contracts/chat-types';
import { InMemoryStorage } from '@artemis/storage';
import { projectHistory } from '../conversations/history.ts';
import { CallStateFilter } from '../turns/envelope.ts';
import { LoopPersistence } from './loop-persistence.ts';
import { ManualClock } from './test-support.ts';

const CONVERSATION = 'c1';
const TURN = 'turn_1';
const NOW = '2026-10-22T10:00:00.000Z';

/** Streams a voice step: each `[blockIndex, text]` delta, then the assembled assistant message. */
async function voiceStep(messageId: string, blocks: string[]) {
  const storage = new InMemoryStorage();
  await storage.conversations.create(
    { id: CONVERSATION, title: null, titleSource: null },
    { systemPrompt: 'MAIN-SYSTEM', tools: [], templateId: 'system', templateHash: 'test' }
  );
  await storage.turns.create({
    id: TURN,
    conversationId: CONVERSATION,
    kind: 'user',
    modality: 'voice',
    mode: 'voice-short',
    effort: null,
    status: 'running',
    clientMessageId: null,
    model: null,
    startedAt: NOW,
  });
  const published: ConversationEvent[] = [];
  const persistence = new LoopPersistence({
    scope: { conversationId: CONVERSATION, taskId: null, turnId: TURN, provider: 'anthropic' },
    storage,
    clock: new ManualClock(),
    signal: new AbortController().signal,
    publish: (event) => published.push(event),
    voice: { filter: new CallStateFilter() },
  });

  for (const [blockIndex, text] of blocks.entries()) {
    await persistence.handle({ type: 'text_delta', messageId, blockIndex, text } as LoopEvent);
  }
  await persistence.handle({
    type: 'assistant_message',
    messageId,
    message: { role: 'assistant', content: blocks.map((text) => ({ type: 'text', text })) },
    response: { model: 'test-model', stopReason: 'end_turn', usage: {}, timings: {} },
  } as unknown as LoopEvent);

  const spoken = new Map<string, string>();
  for (const event of published) {
    if (event.type !== 'assistant_delta') continue;
    spoken.set(event.messageId, (spoken.get(event.messageId) ?? '') + event.text);
  }
  const rows = projectHistory({
    messages: await storage.messages.transcript(CONVERSATION, null),
    toolCalls: [],
    updates: [],
  }).flatMap((row) => (row.role === 'assistant' ? [row] : []));
  return { spoken, rows };
}

test('a voice reply with two text blocks streams each block under its history id', async () => {
  const { spoken, rows } = await voiceStep('msg_1', ['First part.', 'Second part [lis']);

  assert.deepEqual(rows.map((row) => row.id), ['msg_1:0', 'msg_1:1']);
  assert.equal(rows[1]?.text, 'Second part [lis');
  // The held-back tail " [lis" must be streamed under block 1, not block 0.
  assert.equal(spoken.get('msg_1:1'), 'Second part [lis');
  assert.equal(spoken.get('msg_1:0'), 'First part.');
  for (const row of rows) assert.equal(spoken.get(row.id), row.text);
});

test('a single-block voice reply keeps streaming under block 0', async () => {
  const { spoken, rows } = await voiceStep('msg_2', ['Hello there [lis']);

  assert.deepEqual(rows.map((row) => row.id), ['msg_2:0']);
  assert.equal(spoken.get('msg_2:0'), 'Hello there [lis');
  assert.equal(spoken.size, 1);
});
