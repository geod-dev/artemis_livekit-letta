import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EphemeralStorage } from '@artemis/storage/testing';
import { silentLogger } from '../../test/workers-support.ts';
import { recoverAfterRestart } from './recovery.ts';
import { RESTART_TEXT } from './restart.ts';

/** A conversation with one running turn whose assistant message was stored with the given content blocks. */
async function interruptedTurn(content: unknown[]): Promise<EphemeralStorage> {
  const storage = new EphemeralStorage();
  const conversationId = 'conv_recovery';
  await storage.conversations.create(
    { id: conversationId, title: null, titleSource: null },
    { systemPrompt: 'S', tools: [], templateId: 'system', templateHash: 'test' }
  );
  await storage.turns.create({
    id: 'turn_running',
    conversationId,
    kind: 'user',
    modality: 'text',
    mode: 'text',
    effort: null,
    status: 'running',
    clientMessageId: null,
    model: null,
    startedAt: new Date().toISOString(),
  });
  await storage.messages.append({
    id: 'msg_assistant',
    conversationId,
    taskId: null,
    turnId: 'turn_running',
    role: 'assistant',
    content,
    envelope: null,
    provider: null,
    model: null,
    providerMessageId: null,
    stopReason: null,
    usage: null,
    timings: null,
  });
  return storage;
}

test('recovery answers the tool uses of an interrupted assistant message with error results', async () => {
  const storage = await interruptedTurn([
    { type: 'text', text: 'Let me check.' },
    { type: 'tool_use', id: 'toolu_bash', name: 'bash', input: {} },
  ]);

  await recoverAfterRestart({ storage, logger: silentLogger, failTask: async () => {} });

  assert.equal((await storage.turns.get('turn_running'))?.status, 'failed');
  const last = (await storage.messages.transcript('conv_recovery', null)).at(-1);
  assert.equal(last?.role, 'user');
  assert.deepEqual(last?.content, [
    {
      type: 'tool_result',
      toolUseId: 'toolu_bash',
      content: [{ type: 'text', text: RESTART_TEXT }],
      isError: true,
    },
  ]);
});

test('recovery ignores content blocks that are not records or carry no string id', async () => {
  const storage = await interruptedTurn(['junk', null, { type: 'tool_use', id: 7 }, { type: 'tool_use', id: 'toolu_ok' }]);

  await recoverAfterRestart({ storage, logger: silentLogger, failTask: async () => {} });

  const results = (await storage.messages.transcript('conv_recovery', null)).at(-1)?.content as Array<{ toolUseId: string }>;
  assert.deepEqual(
    results.map((block) => block.toolUseId),
    ['toolu_ok']
  );
});

test('recovery adds nothing when the interrupted message has no tool uses', async () => {
  const storage = await interruptedTurn([{ type: 'text', text: 'partial answer' }]);

  await recoverAfterRestart({ storage, logger: silentLogger, failTask: async () => {} });

  assert.equal((await storage.messages.transcript('conv_recovery', null)).length, 1);
  assert.equal((await storage.turns.get('turn_running'))?.status, 'failed');
});
