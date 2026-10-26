import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readVoiceToken } from './use-voice-call.ts';

const tokenBody = {
  serverUrl: 'wss://livekit.example.test',
  roomName: 'room-1',
  participantName: 'user-1',
  participantToken: 'token-1',
  conversation: null,
};

test('call start with a non-JSON 502 shows the start message', async () => {
  await assert.rejects(
    readVoiceToken(new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    (error: unknown) => error instanceof Error && error.message === 'Could not start the call'
  );
});

test('call start shows the server error of a failed JSON response', async () => {
  await assert.rejects(
    readVoiceToken(
      new Response(JSON.stringify({ error: 'Too many calls.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    ),
    (error: unknown) => error instanceof Error && error.message === 'Too many calls.'
  );
});

test('call start reads the room details of a successful response', async () => {
  const body = await readVoiceToken(
    new Response(JSON.stringify(tokenBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  assert.equal(body.roomName, 'room-1');
  assert.equal(body.participantToken, 'token-1');
});
