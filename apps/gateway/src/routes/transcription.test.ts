import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_UPLOAD_BYTES } from '../attachments/limits.ts';
import { type TranscriptionPort, createTranscriptionRoutes } from './transcription.ts';

test('transcription rejects oversized chunked multipart bodies before parsing', async () => {
  const transcriber: TranscriptionPort = { enabled: true, transcribe: async () => 'unused' };
  const app = new Hono().route('/api', createTranscriptionRoutes({ transcriber }));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_UPLOAD_BYTES + 1024 * 1024 + 1));
      controller.close();
    },
  });
  const response = await app.fetch(
    new Request('http://localhost/api/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=unknown' },
      body,
      duplex: 'half',
    } as RequestInit)
  );
  assert.equal(response.status, 413);
});

test('transcription without a key is unavailable and never calls the provider', async () => {
  let called = false;
  const transcriber: TranscriptionPort = {
    enabled: false,
    transcribe: async () => {
      called = true;
      return '';
    },
  };
  const app = new Hono().route('/api', createTranscriptionRoutes({ transcriber }));
  const body = new FormData();
  body.set('audio', new Blob(['small audio']), 'recording.webm');
  const response = await app.fetch(
    new Request('http://localhost/api/transcribe', { method: 'POST', body })
  );
  assert.equal(response.status, 503);
  assert.equal(called, false);
});

test('transcription forwards request cancellation to the provider call', async () => {
  const controller = new AbortController();
  let providerSignal: AbortSignal | undefined;
  const transcriber: TranscriptionPort = {
    enabled: true,
    transcribe: (_audio, signal) => {
      assert.ok(signal instanceof AbortSignal);
      providerSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const app = new Hono().route('/api', createTranscriptionRoutes({ transcriber }));
  const body = new FormData();
  body.set('audio', new Blob(['small audio']), 'recording.webm');
  const pending = app.fetch(
    new Request('http://localhost/api/transcribe', {
      method: 'POST',
      body,
      signal: controller.signal,
    })
  );
  for (let i = 0; i < 10 && !providerSignal; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(providerSignal);
  controller.abort();
  const response = await pending;
  assert.equal(providerSignal.aborted, true);
  assert.equal(response.status, 502);
});
