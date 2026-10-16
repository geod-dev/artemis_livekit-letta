import type { LettaCodeSession } from '@letta-ai/letta-agent-sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error The Letta mod is deployed as JavaScript without declarations.
import activate from '../../../../infrastructure/letta/extensions/notifications.mjs';
import { SessionReader } from '../runtime/session-adapter.ts';
import { configureBackgroundPorts, receiveNotifications } from './service.ts';
import { configureBackgroundStorage, snapshot } from './store.ts';

configureBackgroundStorage({ read: () => null, writeAtomic: async () => undefined });

for (const kind of ['agent', 'command'] as const) {
  for (const removed of [false, true]) {
    test(`${kind} notification wakes once when queue removal returns ${removed}`, async (t) => {
      const conversationId = `handoff-chat-${kind}-${removed}`;
      const previousGateway = process.env.ASSISTANT_GATEWAY_URL;
      const previousRole = process.env.LETTA_CODE_AGENT_ROLE;
      process.env.ASSISTANT_GATEWAY_URL = 'http://gateway.test';
      delete process.env.LETTA_CODE_AGENT_ROLE;
      t.after(() => {
        if (previousGateway === undefined) delete process.env.ASSISTANT_GATEWAY_URL;
        else process.env.ASSISTANT_GATEWAY_URL = previousGateway;
        if (previousRole === undefined) delete process.env.LETTA_CODE_AGENT_ROLE;
        else process.env.LETTA_CODE_AGENT_ROLE = previousRole;
      });
      const runs: string[] = [];
      configureBackgroundPorts({
        isCallActive: () => false,
        announceUpdate: () => false,
        onCallEnded: () => undefined,
        runUpdate: async (_id, request) => {
          runs.push(request.updates[0].report);
          return { success: true };
        },
        publish: () => undefined,
        publishList: () => undefined,
        updateLabel: (title) => title,
      });
      t.mock.method(
        globalThis,
        'fetch',
        async (_url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          const accepted = await receiveNotifications(body.conversationId, body.notifications);
          return Response.json({ accepted, acceptedPayload: true }, { status: 202 });
        }
      );
      let handler!: (event: unknown) => Promise<{ cancel?: unknown } | undefined>;
      activate({
        capabilities: { events: { turns: true } },
        events: {
          on: (_name: string, fn: typeof handler) => {
            handler = fn;
          },
        },
      });
      const report =
        kind === 'agent'
          ? '2026-10-16T15:53:12.078Z'
          : '$ date\n\nExit code: 0\n\n[stdout]\n2026-10-16T15:53:12.078Z';
      const metadata = kind === 'agent' ? 'subagent_type=research conversation_id=worker\n' : '';
      const text = `<task-notification><task-id>race-task</task-id><status>completed</status><summary>${kind} completed</summary><result>${metadata}${report}</result></task-notification>`;
      let streamOpened = false;
      new SessionReader(
        {
          async *stream() {
            if (streamOpened) return;
            streamOpened = true;
            yield {
              type: 'queue_update',
              queue: [{ id: 'queue-race', kind: 'task_notification', content: text }],
            };
            await new Promise(() => {});
          },
          // Letta already dequeued the item to start its notification turn, but
          // turn_start has not run yet. Dequeued is not the same as delivered.
          removeQueuedMessage: async () => ({ removed }),
        } as unknown as LettaCodeSession,
        conversationId,
        { receiveNotifications, publish: () => undefined }
      );
      await new Promise((resolve) => setImmediate(resolve));
      const result = await handler({
        agentId: 'assistant',
        conversationId,
        input: [{ role: 'user', content: text }],
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(result?.cancel, 'the mod transfers delivery responsibility to the gateway');
      assert.deepEqual(runs, [report]);
      assert.equal(
        Object.values(snapshot().updates).find((u) => u.conversationId === conversationId)
          ?.delivery,
        'delivered'
      );
    });
  }
}
