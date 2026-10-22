import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Clock } from '@artemis/core';
import type { ConversationEvent } from '@artemis/contracts/chat-types';
import { ConversationEventHub } from './hub.ts';

/** Manual clock: `now` only moves when a test says so. */
function fakeClock(start = 0): Clock & { advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    setTimeout: () => ({ cancel: () => undefined }),
    setInterval: () => ({ cancel: () => undefined }),
  };
}

function collect(hub: ConversationEventHub, conversationId: string) {
  const received: ConversationEvent[] = [];
  const unsubscribe = hub.subscribe(conversationId, (event) => received.push(event));
  return { received, unsubscribe };
}

describe('ConversationEventHub', () => {
  it('sends a snapshot of in-flight turns first, then live events', () => {
    const hub = new ConversationEventHub(fakeClock());
    hub.publish('c1', { type: 'turn_start', turnId: 't1', modality: 'text' });
    hub.publish('c1', { type: 'assistant_delta', turnId: 't1', messageId: 'm1:0', text: 'Hel' });

    const { received } = collect(hub, 'c1');
    assert.equal(received[0]?.type, 'snapshot');
    const snapshot = received[0];
    assert.ok(snapshot?.type === 'snapshot');
    assert.deepEqual(snapshot.turns, [{ turnId: 't1', modality: 'text' }]);
    assert.equal(snapshot.activeEvents.length, 2);

    hub.publish('c1', { type: 'assistant_delta', turnId: 't1', messageId: 'm1:0', text: 'lo' });
    assert.equal(received.length, 2);
    assert.deepEqual(received[1],{ type: 'assistant_delta', turnId: 't1', messageId: 'm1:0', text: 'lo' });
  });

  it('merges deltas of one message in the retained snapshot', () => {
    const hub = new ConversationEventHub(fakeClock());
    hub.publish('c1', { type: 'turn_start', turnId: 't1', modality: 'text' });
    hub.publish('c1', { type: 'assistant_delta', turnId: 't1', messageId: 'm:0', text: 'a' });
    hub.publish('c1', { type: 'assistant_delta', turnId: 't1', messageId: 'm:0', text: 'b' });
    const { received } = collect(hub, 'c1');
    const snapshot = received[0];
    assert.ok(snapshot?.type === 'snapshot');
    assert.deepEqual(snapshot.activeEvents[1], { type: 'assistant_delta', turnId: 't1', messageId: 'm:0', text: 'ab' });
  });

  it('forgets a turn once it ends and sends an empty snapshot', () => {
    const hub = new ConversationEventHub(fakeClock());
    hub.publish('c1', { type: 'turn_start', turnId: 't1', modality: 'voice' });
    hub.publish('c1', { type: 'turn_end', turnId: 't1', success: true });
    const { received } = collect(hub, 'c1');
    assert.deepEqual(received[0], { type: 'snapshot', turns: [], tasks: [], activeEvents: [] });
  });

  it('retains running tasks until they finish', () => {
    const hub = new ConversationEventHub(fakeClock());
    hub.publish('c1', { type: 'task', taskId: 'task_1', status: 'running', title: 'Research' });
    let snapshot = collect(hub, 'c1').received[0];
    assert.ok(snapshot?.type === 'snapshot');
    assert.deepEqual(snapshot.tasks, [{ taskId: 'task_1', status: 'running', title: 'Research' }]);

    hub.publish('c1', { type: 'task', taskId: 'task_1', status: 'finished', title: 'Research' });
    snapshot = collect(hub, 'c1').received[0];
    assert.ok(snapshot?.type === 'snapshot');
    assert.deepEqual(snapshot.tasks, []);
  });

  it('bounds the retained events of a turn', () => {
    const hub = new ConversationEventHub(fakeClock());
    hub.publish('c1', { type: 'turn_start', turnId: 't1', modality: 'text' });
    for (let index = 0; index < 50; index += 1) {
      hub.publish('c1', { type: 'tool_call', turnId: 't1', toolCallId: `call_${index}`, name: 'bash' });
    }
    const snapshot = collect(hub, 'c1').received[0];
    assert.ok(snapshot?.type === 'snapshot');
    assert.ok(snapshot.activeEvents.length <= 32);
  });

  it('stops delivering to an unsubscribed listener', () => {
    const hub = new ConversationEventHub(fakeClock());
    const { received, unsubscribe } = collect(hub, 'c1');
    unsubscribe();
    hub.publish('c1', { type: 'updates_changed' });
    assert.equal(received.length, 1);
  });

  it('publishes list events to list subscribers only', () => {
    const hub = new ConversationEventHub(fakeClock());
    const listed: unknown[] = [];
    const unsubscribe = hub.subscribeList((event) => listed.push(event));
    const conversation = collect(hub, 'c1');
    hub.publishList({ type: 'unread', conversationId: 'c1', unread: 2 });
    unsubscribe();
    assert.deepEqual(listed, [{ type: 'unread', conversationId: 'c1', unread: 2 }]);
    assert.equal(conversation.received.length, 1);
  });

  it('drops retained state of conversations idle for 30 minutes', () => {
    const clock = fakeClock();
    const hub = new ConversationEventHub(clock);
    hub.publish('c1', { type: 'turn_start', turnId: 't1', modality: 'text' });
    clock.advance(31 * 60_000);
    hub.publish('c2', { type: 'updates_changed' });
    const snapshot = collect(hub, 'c1').received[0];
    assert.ok(snapshot?.type === 'snapshot');
    assert.deepEqual(snapshot.turns, []);
  });
});
