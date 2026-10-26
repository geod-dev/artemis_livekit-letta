import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroqTranscriber } from './transcription.ts';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const PROVIDER_RESPONSE_BYTES = 1024 * 1024;

interface Call {
  url: string;
  init: RequestInit;
}

// A fake for the fetch the transcriber receives: records each call and answers with `respond`.
function fakeFetch(respond: () => Response) {
  const calls: Call[] = [];
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return respond();
  };
  return { send: send as typeof fetch, calls };
}

function recording(name = 'voice.webm'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'audio/webm' });
}

test('sends the recording to Groq with the bearer key, the model and fixed transcription options', async () => {
  const fake = fakeFetch(() => Response.json({ text: '  hello there ' }));
  const transcriber = createGroqTranscriber({ apiKey: 'test-key', model: 'whisper-test', fetch: fake.send });

  assert.equal(transcriber.enabled, true);
  assert.equal(await transcriber.transcribe(recording()), 'hello there');

  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.ok(call);
  assert.equal(call.url, GROQ_URL);
  assert.equal(call.init.method, 'POST');
  assert.equal((call.init.headers as Record<string, string>).Authorization, 'Bearer test-key');
  const body = call.init.body as FormData;
  assert.equal(body.get('model'), 'whisper-test');
  assert.equal(body.get('response_format'), 'json');
  assert.equal(body.get('temperature'), '0');
  assert.equal((body.get('file') as File).name, 'voice.webm');
});

test('names an unnamed recording recording.webm', async () => {
  const fake = fakeFetch(() => Response.json({ text: 'ok' }));
  const transcriber = createGroqTranscriber({ apiKey: 'test-key', model: 'whisper-test', fetch: fake.send });

  await transcriber.transcribe(recording(''));

  const call = fake.calls[0];
  assert.ok(call);
  assert.equal(((call.init.body as FormData).get('file') as File).name, 'recording.webm');
});

test('is disabled without a key and refuses before calling the provider', async () => {
  const fake = fakeFetch(() => Response.json({ text: 'never sent' }));
  const transcriber = createGroqTranscriber({ model: 'whisper-test', fetch: fake.send });

  assert.equal(transcriber.enabled, false);
  await assert.rejects(transcriber.transcribe(recording()), /GROQ_API_KEY/);
  assert.equal(fake.calls.length, 0);
});

test('returns an empty transcript when the provider omits text', async () => {
  const fake = fakeFetch(() => Response.json({}));
  const transcriber = createGroqTranscriber({ apiKey: 'test-key', model: 'whisper-test', fetch: fake.send });

  assert.equal(await transcriber.transcribe(recording()), '');
});

test('maps a provider failure to an error that carries the status and a bounded detail', async () => {
  const fake = fakeFetch(() => new Response('rate limited', { status: 429 }));
  const transcriber = createGroqTranscriber({ apiKey: 'test-key', model: 'whisper-test', fetch: fake.send });

  await assert.rejects(transcriber.transcribe(recording()), /^Error: Transcription failed \(429\) rate limited$/);
});

test('rejects a transcript that is not a string', async () => {
  const fake = fakeFetch(() => Response.json({ text: 42 }));
  const transcriber = createGroqTranscriber({ apiKey: 'test-key', model: 'whisper-test', fetch: fake.send });

  await assert.rejects(transcriber.transcribe(recording()), /invalid response/);
});

test('refuses a provider body over the response limit', async () => {
  const oversized = JSON.stringify({ text: 'x'.repeat(PROVIDER_RESPONSE_BYTES) });
  const fake = fakeFetch(() => new Response(oversized));
  const transcriber = createGroqTranscriber({ apiKey: 'test-key', model: 'whisper-test', fetch: fake.send });

  await assert.rejects(transcriber.transcribe(recording()), /too large/);
});
