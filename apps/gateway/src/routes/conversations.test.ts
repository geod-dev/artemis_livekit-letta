import { MAX_ATTACHMENT_BYTES } from '@artemis/contracts/chat-types';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentServerClient } from '../agent-server/client.ts';
import type { AttachmentStore } from '../attachments/attachment-store.ts';
import { createConversationRoutes } from './conversations.ts';

interface Relayed {
  method: string;
  path: string;
  body?: string;
}

type Responder = (relayed: Relayed) => Response;

const accepted: Responder = () => Response.json({});

/** A fake agent-server that records each relayed request, and a fake attachment store that records its bookkeeping. */
function harness(respond: Responder = accepted) {
  const relayed: Relayed[] = [];
  const bookkeeping = { reserved: [] as string[], released: [] as string[], replaced: [] as string[] };
  const agent = {
    relay: async (request: Request, path: string, body?: string) => {
      const entry = { method: request.method, path, body };
      relayed.push(entry);
      return respond(entry);
    },
  } as unknown as AgentServerClient;
  const store = {
    resolve: async (attachments: unknown[]) => attachments,
    conversations: {
      reserve: async (id: string) => {
        bookkeeping.reserved.push(id);
        return async () => {
          bookkeeping.released.push(id);
        };
      },
      release: async (id: string) => {
        bookkeeping.released.push(id);
      },
      replace: async (id: string) => {
        bookkeeping.replaced.push(id);
      },
    },
  } as unknown as AttachmentStore;
  const app = new Hono().route('/api/conversations', createConversationRoutes(agent, store));
  return { app, relayed, bookkeeping };
}

const url = (path: string) => `http://localhost/api/conversations${path}`;

test('task and context routes relay to the agent-server with the task id encoded', async () => {
  const { app, relayed } = harness();
  const calls = [
    ['GET', '/c1/tasks'],
    ['GET', '/c1/tasks/t%201'],
    ['POST', '/c1/tasks/t1/cancel'],
    ['POST', '/c1/cancel'],
    ['GET', '/c1/context-usage'],
  ] as const;
  for (const [method, path] of calls) {
    const response = await app.request(url(path), { method });
    assert.equal(response.status, 200, `${method} ${path}`);
  }
  assert.deepEqual(
    relayed.map((entry) => entry.path),
    [
      '/v1/conversations/c1/tasks',
      '/v1/conversations/c1/tasks/t%201',
      '/v1/conversations/c1/tasks/t1/cancel',
      '/v1/conversations/c1/cancel',
      '/v1/conversations/c1/context-usage',
    ]
  );
});

test('a deleted conversation releases its uploads only when the agent-server accepts the delete', async () => {
  const accept = harness(() => new Response(null, { status: 204 }));
  assert.equal((await accept.app.request(url('/c1'), { method: 'DELETE' })).status, 204);
  assert.deepEqual(accept.bookkeeping.released, ['c1']);

  const refuse = harness(() => Response.json({ error: 'unknown' }, { status: 404 }));
  assert.equal((await refuse.app.request(url('/c1'), { method: 'DELETE' })).status, 404);
  assert.deepEqual(refuse.bookkeeping.released, []);
});

test('a message delete hands the remaining attachments to the registry and returns the body', async () => {
  const { app, bookkeeping } = harness(() => Response.json({ attachments: [] }));
  const response = await app.request(url('/c1/messages/m1'), { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { attachments: [] });
  assert.deepEqual(bookkeeping.replaced, ['c1']);
});

test('an accepted message delete is never answered as a failure when its body cannot be read', async () => {
  const unreadable: Responder = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('connection reset'));
        },
      }),
      { status: 200, headers: { 'content-length': '40' } }
    );
  const { app, bookkeeping } = harness(unreadable);
  const response = await app.request(url('/c1/messages/m1'), { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), null);
  assert.deepEqual(bookkeeping.replaced, []);
});

test('a turn with an attachment above the upload limit is refused before the agent-server sees it', async () => {
  const { app, relayed, bookkeeping } = harness();
  const response = await app.request(url('/c1/messages'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'see attached',
      attachments: [
        { path: 'uploads/a.bin', name: 'a.bin', kind: 'file', size: MAX_ATTACHMENT_BYTES + 1 },
      ],
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(relayed.length, 0);
  assert.deepEqual(bookkeeping.reserved, []);
});

test('a turn accepted by the agent-server keeps its uploads referenced', async () => {
  const { app, bookkeeping } = harness(() => new Response(null, { status: 202 }));
  const response = await app.request(url('/c1/messages'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'see attached',
      attachments: [
        { path: 'uploads/a.png', name: 'a.png', kind: 'image', size: MAX_ATTACHMENT_BYTES },
      ],
    }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(bookkeeping.reserved, ['c1']);
  assert.deepEqual(bookkeeping.released, []);
});
