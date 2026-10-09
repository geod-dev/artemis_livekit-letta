import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '@backend/chat-types';
import { toThreadMessages } from './thread-messages.ts';

const user = (id: string, text: string, modality: 'text' | 'voice' = 'text'): ChatMessage => ({
  id,
  role: 'user',
  text,
  modality,
});
const assistant = (id: string, text: string): ChatMessage => ({ id, role: 'assistant', text });

test('keeps reasoning separate from answer text within the same response', () => {
  const { messages } = toThreadMessages([
    user('u', 'hi'),
    { id: 'reasoning:a', role: 'reasoning', text: 'Considering the request' },
    assistant('a', 'Hello'),
  ]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].content, [
    { type: 'reasoning', text: 'Considering the request' },
    { type: 'text', text: 'Hello' },
  ]);
});
const tool = (id: string, result?: string): ChatMessage => ({
  id,
  role: 'tool',
  toolCallId: id,
  name: 'web_search',
  args: '{"query":"x"}',
  result,
});

test('merges consecutive assistant and tool rows into one assistant message', () => {
  const { messages } = toThreadMessages([
    user('u1', 'hi'),
    tool('t1', 'found'),
    assistant('a1', 'Here you go'),
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].id, 't1');
  assert.equal(messages[1].role, 'assistant');
  assert.deepEqual(messages[1].content, [
    {
      type: 'tool-call',
      toolCallId: 't1',
      toolName: 'web_search',
      args: { query: 'x' },
      argsText: '{"query":"x"}',
      result: 'found',
      isError: undefined,
    },
    { type: 'text', text: 'Here you go' },
  ]);
});

test('voice turns mark the user message and its reply as voice', () => {
  const { messages } = toThreadMessages([
    user('u1', 'typed'),
    assistant('a1', 'reply'),
    user('u2', 'spoken', 'voice'),
    assistant('a2', 'spoken reply'),
  ]);
  assert.deepEqual(
    messages.map((m) => m.metadata?.modality),
    [undefined, undefined, 'voice', 'voice']
  );
});

test('events become system messages that keep their kind', () => {
  const { messages } = toThreadMessages([
    { id: 'e1', role: 'event', kind: 'task_result', text: 'Task done' },
  ]);
  assert.equal(messages[0].role, 'system');
  assert.deepEqual(messages[0].metadata, { custom: { kind: 'task_result' } });
});

test('reuses converted messages whose sources did not change', () => {
  const u1 = user('u1', 'hi');
  const a1 = assistant('a1', 'Hel');
  const first = toThreadMessages([u1, a1]);
  const second = toThreadMessages([u1, assistant('a1', 'Hello')], first.cache);
  assert.equal(second.messages[0], first.messages[0]);
  assert.notEqual(second.messages[1], first.messages[1]);
});

test('marks the reply of a stopped turn as cancelled', () => {
  const rows = [user('u1', 'hi'), assistant('a1', 'Hel'), user('u2', 'again')];
  const { messages } = toThreadMessages(rows, new Map(), new Set(['a1']));
  assert.deepEqual(messages[1].status, { type: 'incomplete', reason: 'cancelled' });
  assert.equal(messages[2].status, undefined);
});

test('adds an empty cancelled reply when a stopped turn left none', () => {
  const rows = [user('u1', 'hi')];
  const first = toThreadMessages(rows);
  const stopped = toThreadMessages(rows, first.cache, new Set(['u1']));
  assert.equal(stopped.messages.length, 2);
  assert.equal(stopped.messages[1].role, 'assistant');
  assert.deepEqual(stopped.messages[1].content, []);
  assert.deepEqual(stopped.messages[1].status, { type: 'incomplete', reason: 'cancelled' });
});

test('tolerates missing or invalid tool arguments', () => {
  const { messages } = toThreadMessages([
    { id: 't1', role: 'tool', toolCallId: 't1', name: 'x', args: 'not json' },
  ]);
  const part = (messages[0].content as readonly { args?: unknown }[])[0];
  assert.deepEqual(part.args, {});
});
