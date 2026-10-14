import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { test } from 'node:test';
import { config } from '../assistant/config.ts';
import { MAX_RECORDING_BYTES } from '../assistant/filesystem/workspace-adapter.ts';
import { utilities } from './utilities.ts';

const app = new Hono().route('/api', utilities);

test('transcription rejects oversized chunked multipart bodies before parsing', async () => {
  const oldKey = config.transcription.groqApiKey;
  config.transcription.groqApiKey = 'test-key';
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RECORDING_BYTES + 1024 * 1024 + 1));
        controller.close();
      },
    });
    const response = await app.fetch(new Request('http://localhost/api/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=unknown' },
      body,
      duplex: 'half',
    } as RequestInit));
    assert.equal(response.status, 413);
  } finally {
    config.transcription.groqApiKey = oldKey;
  }
});

test('transcription forwards request cancellation to the provider call', async () => {
  const oldKey = config.transcription.groqApiKey;
  const originalFetch = globalThis.fetch;
  config.transcription.groqApiKey = 'test-key';
  const controller = new AbortController();
  let providerSignal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    providerSignal = signal;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  try {
    const body = new FormData();
    body.set('audio', new Blob(['small audio']), 'recording.webm');
    const pending = app.fetch(new Request('http://localhost/api/transcribe', {
      method: 'POST',
      body,
      signal: controller.signal,
    }));
    for (let i = 0; i < 10 && !providerSignal; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(providerSignal);
    controller.abort();
    const response = await pending;
    assert.equal(providerSignal.aborted, true);
    assert.equal(response.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
    config.transcription.groqApiKey = oldKey;
  }
});
