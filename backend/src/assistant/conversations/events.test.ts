import assert from 'node:assert/strict';
import test from 'node:test';
import { clearConversationEvents, publish, subscribeWithSnapshot } from './events.ts';

test('snapshot contains active state and aggregated output, not finished event history', () => {
  const id = `events-${Date.now()}`;
  publish(id, { type: 'turn_start', turnId: 'turn-1', modality: 'text' });
  publish(id, { type: 'message', turnId: 'turn-1', message: { id: 'user-1', role: 'user', text: 'hello', modality: 'text' } });
  publish(id, { type: 'assistant_delta', turnId: 'turn-1', messageId: 'assistant-1', text: 'hel' });
  publish(id, { type: 'assistant_delta', turnId: 'turn-1', messageId: 'assistant-1', text: 'lo' });

  const received: unknown[] = [];
  const unsubscribe = subscribeWithSnapshot(id, (event) => received.push(event));
  const snapshot = received[0] as { type: string; turns: unknown[]; activeEvents: Array<{ type: string; text?: string }> };
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.activeEvents.filter((event) => event.type === 'turn_start').length, 1);
  assert.equal(snapshot.activeEvents.find((event) => event.type === 'assistant_delta')?.text, 'hello');
  unsubscribe();

  publish(id, { type: 'turn_end', turnId: 'turn-1', success: true });
  const afterEnd: unknown[] = [];
  const unsubscribeAfterEnd = subscribeWithSnapshot(id, (event) => afterEnd.push(event));
  assert.deepEqual(afterEnd[0], { type: 'snapshot', turns: [], tasks: [], activeEvents: [] });
  unsubscribeAfterEnd();
  clearConversationEvents(id);
});
