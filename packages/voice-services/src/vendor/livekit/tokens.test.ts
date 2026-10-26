import { VOICE_DISPATCH_KEYS } from '@artemis/contracts/agent-server';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenVerifier } from 'livekit-server-sdk';
import { createVoiceTokenIssuer } from './tokens.ts';

const settings = {
  url: 'wss://livekit.example.test',
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret-0123456789abcdef',
  agentName: 'voice-agent',
};

interface JwtPayload {
  sub?: string;
  name?: string;
  video?: Record<string, unknown>;
  exp?: number;
  roomConfig?: { agents?: Array<{ agentName?: string; metadata?: string }> };
}

// The token expires `seconds` from now (a few seconds of slack for the clock between mint and check).
function assertExpiresIn(payload: JwtPayload, seconds: number): void {
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs((payload.exp ?? 0) - (now + seconds)) <= 5, `expires ${payload.exp}, expected about ${now + seconds}`);
}

// Reads the claims without checking the signature; the signature is checked separately.
function payloadOf(jwt: string): JwtPayload {
  return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as JwtPayload;
}

test('a call token joins a fresh room with publish and subscribe rights', async () => {
  const issuer = createVoiceTokenIssuer(settings);

  const token = await issuer.forCall('conv-1', 'short');

  assert.equal(token.serverUrl, settings.url);
  assert.match(token.roomName, /^call-conv-1-[0-9a-f]{8}$/);
  assert.equal(token.participantName, 'user');
  const payload = payloadOf(token.participantToken);
  assert.equal(payload.name, 'user');
  assert.equal(payload.video?.room, token.roomName);
  assert.equal(payload.video?.roomJoin, true);
  assert.equal(payload.video?.canPublish, true);
  assert.equal(payload.video?.canPublishData, true);
  assert.equal(payload.video?.canSubscribe, true);
  assertExpiresIn(payload, 30 * 60);
});

test('a call token dispatches the voice agent into the room with the conversation and call mode', async () => {
  const issuer = createVoiceTokenIssuer(settings);

  const token = await issuer.forCall('conv-2', 'long');

  const [agent] = payloadOf(token.participantToken).roomConfig?.agents ?? [];
  assert.equal(agent?.agentName, settings.agentName);
  assert.deepEqual(JSON.parse(agent?.metadata ?? '{}'), {
    [VOICE_DISPATCH_KEYS.conversationId]: 'conv-2',
    [VOICE_DISPATCH_KEYS.callMode]: 'long',
  });
});

test('a warm-up token joins a room with no agent dispatched and no publish rights', async () => {
  const issuer = createVoiceTokenIssuer(settings);

  const token = await issuer.warmup();

  assert.match(token.roomName, /^warmup-[0-9a-f]{8}$/);
  const payload = payloadOf(token.participantToken);
  assert.equal(payload.video?.roomJoin, true);
  assert.equal(payload.video?.canPublish, undefined);
  assert.equal(payload.roomConfig, undefined);
  assertExpiresIn(payload, 5 * 60);
});

test('each token is signed with the API secret and fails verification with any other secret', async () => {
  const issuer = createVoiceTokenIssuer(settings);
  const token = await issuer.forCall('conv-3', 'short');

  const claims = await new TokenVerifier(settings.apiKey, settings.apiSecret).verify(token.participantToken);
  assert.equal(claims.video?.room, token.roomName);
  await assert.rejects(new TokenVerifier(settings.apiKey, 'some-other-secret-0123456789abcdef').verify(token.participantToken));
});

test('every token gets its own identity', async () => {
  const issuer = createVoiceTokenIssuer(settings);

  const first = await issuer.warmup();
  const second = await issuer.warmup();

  assert.notEqual(payloadOf(first.participantToken).sub, payloadOf(second.participantToken).sub);
});
