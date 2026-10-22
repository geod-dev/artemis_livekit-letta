import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from './errors.ts';
import { readSse } from './sse-client.ts';
import { eventStream } from './sse-server.ts';

async function collect<E>(iterable: AsyncIterable<E>): Promise<E[]> {
  const events: E[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function bodyFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('an oversized synchronous snapshot closes and releases its subscription', async () => {
  let stopped = 0;
  const response = eventStream(new Request('http://localhost/events'), (send) => {
    send({ text: 'x'.repeat(256 * 1024) });
    return () => {
      stopped++;
    };
  });
  assert.equal(await response.text(), ': connected\n\n');
  assert.equal(stopped, 1);
});

test('a close requested during start still runs the returned cleanup', async () => {
  let stopped = 0;
  const response = eventStream<unknown>(new Request('http://localhost/events'), (_send, close) => {
    close();
    return () => {
      stopped++;
    };
  });
  assert.equal(await response.text(), ': connected\n\n');
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

test('a throwing subscriber start closes the stream', async (t) => {
  t.mock.method(console, 'error', () => {});
  const response = eventStream(new Request('http://localhost/events'), () => {
    throw new Error('subscribe failed');
  });
  assert.equal(await response.text(), ': connected\n\n');
});

test('the stream opens with a connected comment, then one data frame per event', async () => {
  const response = eventStream<{ a: number }>(new Request('http://localhost/events'), (send, close) => {
    send({ a: 1 });
    send({ a: 2 });
    setTimeout(close, 0);
  });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(await response.text(), ': connected\n\ndata: {"a":1}\n\ndata: {"a":2}\n\n');
});

test('keepalive pings are sent on the period and a reader cancel runs the cleanup', async () => {
  let stopped = 0;
  const response = eventStream(new Request('http://localhost/events'), () => () => {
    stopped++;
  }, { keepAliveMs: 5 });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  assert.equal(decoder.decode((await reader.read()).value), ': connected\n\n');
  assert.equal(decoder.decode((await reader.read()).value), ': ping\n\n');
  await reader.cancel();
  assert.equal(stopped, 1);
});

test('a client abort closes the stream and runs the cleanup once', async () => {
  const controller = new AbortController();
  let stopped = 0;
  const response = eventStream(new Request('http://localhost/events', { signal: controller.signal }), () => () => {
    stopped++;
  }, { keepAliveMs: 60_000 });
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(stopped, 1);
});

test('readSse parses what eventStream writes', async () => {
  const response = eventStream<{ text: string; n: number }>(new Request('http://localhost/events'), (send, close) => {
    send({ text: 'first', n: 1 });
    send({ text: 'line\nbreak "quoted"', n: 2 });
    setTimeout(close, 0);
  }, { keepAliveMs: 60_000 });
  assert.deepEqual(await collect(readSse<{ text: string; n: number }>(response.body!)), [
    { text: 'first', n: 1 },
    { text: 'line\nbreak "quoted"', n: 2 },
  ]);
});

test('readSse handles CRLF, comments, split chunks and multi-line data', async () => {
  const events = await collect(
    readSse<unknown>(
      bodyFrom([
        'data: {"a":1}\r\n\r\n: comment\n',
        'event: update\nid: 7\ndata: {"b":\n',
        'data: 2}\n\n',
        'data:{"c":3}\n\n',
        'data: {"d":4}',
      ])
    )
  );
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('readSse rejects a payload that is not JSON', async () => {
  await assert.rejects(collect(readSse(bodyFrom(['data: nope\n\n']))), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    assert.equal(error.code, 'bad_event');
    return true;
  });
});

test('readSse throws the abort reason when the signal aborts a stalled body', async () => {
  const controller = new AbortController();
  const stalled = new ReadableStream<Uint8Array>({});
  const consuming = collect(readSse(stalled, controller.signal));
  setTimeout(() => controller.abort(new Error('caller gave up')), 0);
  await assert.rejects(consuming, /caller gave up/);
});
