import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorResponse } from '@artemis/http';
import { Hono } from 'hono';
import type { ConversationService } from '../conversations/service.ts';
import type { ConversationEventHub } from '../events/hub.ts';
import type { BackgroundDeliveryService } from '../tasks/delivery.ts';
import type { TaskPort } from '../tools/task-port.ts';
import { conversationRoutes } from './conversations.ts';

/** Test double: `members` names what the test uses; anything else is absent. */
function fake<T>(members: Partial<T>): T {
  return members as T;
}

const CONV = '00000000-0000-4000-8000-0000000000c1';
const CURSOR = '00000000-0000-4000-8000-0000000000e1';

function api(conversations: Partial<ConversationService>): Hono {
  const app = new Hono();
  app.onError((error) => errorResponse(error));
  app.route(
    '/',
    conversationRoutes({
      conversations: fake<ConversationService>(conversations),
      tasks: fake<TaskPort>({}),
      delivery: fake<Pick<BackgroundDeliveryService, 'markRead'>>({}),
      events: fake<ConversationEventHub>({}),
    })
  );
  return app;
}

test('list rejects a non-uuid after cursor with 400', async () => {
  let listed = 0;
  const app = api({
    list: async () => {
      listed += 1;
      return { items: [], nextCursor: null };
    },
  });
  const rejected = await app.request('/conversations?after=abc');
  assert.equal(rejected.status, 400);
  assert.equal(((await rejected.json()) as { code?: string }).code, 'invalid_cursor');
  assert.equal(listed, 0);

  const accepted = await app.request(`/conversations?after=${CURSOR}`);
  assert.equal(accepted.status, 200);
  assert.equal(listed, 1);
});

test('messages rejects a non-uuid before cursor with 400', async () => {
  let paged = 0;
  const app = api({
    messages: async () => {
      paged += 1;
      return { rows: [], nextCursor: null };
    },
  });
  const rejected = await app.request(`/conversations/${CONV}/messages?before=abc`);
  assert.equal(rejected.status, 400);
  assert.equal(((await rejected.json()) as { code?: string }).code, 'invalid_cursor');
  assert.equal(paged, 0);

  const accepted = await app.request(`/conversations/${CONV}/messages?before=${CURSOR}`);
  assert.equal(accepted.status, 200);
  assert.equal(paged, 1);
});
