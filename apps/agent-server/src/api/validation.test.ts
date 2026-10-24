import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from 'hono';
import { AppError, NotFoundError } from '@artemis/core';
import { MAX_TURN_ATTACHMENTS } from '@artemis/contracts/chat-types';
import {
  parseAttachments,
  parseLimit,
  requireEffort,
  requireUuidParam,
  optionalList,
  validMessages,
} from './validation.ts';

const UUID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

function invalid(fn: () => unknown, code = 'invalid_field'): void {
  assert.throws(fn, (error: unknown) => error instanceof AppError && error.code === code && error.status === 400);
}

test('parseLimit takes the fallback when absent and bounds the value', () => {
  assert.equal(parseLimit(undefined, 20, 100), 20);
  assert.equal(parseLimit('', 20, 100), 20);
  assert.equal(parseLimit('1', 20, 100), 1);
  assert.equal(parseLimit('100', 20, 100), 100);
  for (const raw of ['0', '101', '2.5', 'abc', '-3']) {
    assert.throws(() => parseLimit(raw, 20, 100), (error: unknown) => error instanceof AppError && error.code === 'invalid_limit');
  }
});

test('optionalList is empty when absent, rejects non-lists and lists over the bound', () => {
  assert.deepEqual(optionalList({}, 'ids', 3), []);
  assert.deepEqual(optionalList({ ids: [1, 2] }, 'ids', 3), [1, 2]);
  invalid(() => optionalList({ ids: 'x' }, 'ids', 3));
  invalid(() => optionalList({ ids: [1, 2, 3, 4] }, 'ids', 3));
});

test('requireUuidParam passes uuids and reserved literals, and answers 404 for anything else', async () => {
  let reached = 0;
  const next = async () => {
    reached += 1;
  };
  const context = (value: string) => ({ req: { param: () => value } }) as unknown as Context;

  await requireUuidParam('id', 'Conversation')(context(UUID), next);
  await requireUuidParam('id', 'Conversation', ['latest'])(context('latest'), next);
  assert.equal(reached, 2);

  await assert.rejects(requireUuidParam('id', 'Conversation')(context('latest'), next), (error: unknown) => {
    return error instanceof NotFoundError && error.status === 404 && error.message === 'Conversation not found';
  });
  await assert.rejects(requireUuidParam('id', 'Conversation', ['latest'])(context('not-a-uuid'), next), NotFoundError);
  assert.equal(reached, 2);
});

test('parseAttachments keeps the known fields and checks the shape of each entry', () => {
  assert.deepEqual(parseAttachments(undefined), []);
  assert.deepEqual(
    parseAttachments([{ path: 'uploads/a.png', name: 'a.png', kind: 'image', mimeType: 'image/png', size: 9, extra: true }]),
    [{ path: 'uploads/a.png', name: 'a.png', kind: 'image', mimeType: 'image/png', size: 9 }]
  );
  invalid(() => parseAttachments('nope'));
  invalid(() => parseAttachments(Array.from({ length: MAX_TURN_ATTACHMENTS + 1 }, () => ({}))));
  invalid(() => parseAttachments([null]));
  invalid(() => parseAttachments([{ path: 'a', name: 'a', kind: 'video' }]));
  invalid(() => parseAttachments([{ path: '', name: 'a', kind: 'file' }]));
  invalid(() => parseAttachments([{ path: 'a', name: 1, kind: 'file' }]));
  invalid(() => parseAttachments([{ path: 'a', name: 'a', kind: 'file', size: '9' }]));
});

test('requireEffort accepts the known efforts only', () => {
  assert.equal(requireEffort('high'), 'high');
  invalid(() => requireEffort('extreme'));
  invalid(() => requireEffort(undefined));
});

test('validMessages bounds the list, the roles and the text of each message', () => {
  assert.equal(validMessages([{ role: 'user', content: 'hi' }]), true);
  assert.equal(validMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), true);
  assert.equal(validMessages([{ role: 'user' }]), true);
  assert.equal(validMessages('nope'), false);
  assert.equal(validMessages([]), true);
  assert.equal(validMessages([null]), false);
  assert.equal(validMessages([{ content: 'no role' }]), false);
  assert.equal(validMessages([{ role: 'user', content: 'x'.repeat(100_001) }]), false);
  assert.equal(validMessages([{ role: 'user', content: [{ text: 3 }] }]), false);
  assert.equal(validMessages([{ role: 'user', content: 42 }]), false);
  assert.equal(validMessages(Array.from({ length: 101 }, () => ({ role: 'user', content: 'x' }))), false);
});
