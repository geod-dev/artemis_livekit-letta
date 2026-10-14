import assert from 'node:assert/strict';
import test from 'node:test';
import { eventStream } from './http';

test('an oversized synchronous snapshot closes and releases its subscription', async () => {
  let stopped = 0;
  const response = eventStream(new Request('http://localhost/events'), (send) => {
    send({ text: 'x'.repeat(256 * 1024) });
    return () => { stopped++; };
  });
  assert.equal(await response.text(), '');
  assert.equal(stopped, 1);
});

test('an already aborted event request never starts a subscription', async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;
  const response = eventStream(new Request('http://localhost/events', { signal: controller.signal }), () => {
    started = true;
    return () => {};
  });
  assert.equal(await response.text(), '');
  assert.equal(started, false);
});
