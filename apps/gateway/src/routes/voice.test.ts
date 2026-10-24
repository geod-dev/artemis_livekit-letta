import { VOICE_DISPATCH_KEYS } from '@artemis/contracts/agent-server';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { AgentServerClient } from '../agent-server/client.ts';
import { type GatewayDependencies, composeGateway } from '../compose.ts';
import { validateConfig } from '../config.ts';
import { createVoiceRoutes } from './voice.ts';

const VOICE_TOKEN = 'voice-route-test-token';
const LIVEKIT = {
  url: 'ws://livekit.test:7880',
  apiKey: 'route-test-key',
  apiSecret: 'route-test-secret-that-is-long-enough-for-hs256',
  agentName: 'assistant',
};
let root = '';
let voiceTokens: GatewayDependencies['voiceTokens'];
// The workspace root is created per run, under the OS temp dir, when the suite starts.
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'artemis-gateway-voice-'));
  // The LiveKit token issuer comes from the composition root, as in server.ts.
  voiceTokens = composeGateway(
    validateConfig({
      AGENT_SERVER_URL: 'http://127.0.0.1:9',
      AGENT_SERVER_TOKEN: 'voice-route-agent-token',
      ARTEMIS_PASSWORD: 'voice-route-password',
      WORKSPACE_PATH: join(root, 'workspace'),
      ARTEMIS_DATA_DIR: join(root, 'data'),
      LIVEKIT_URL: LIVEKIT.url,
      LIVEKIT_API_KEY: LIVEKIT.apiKey,
      LIVEKIT_API_SECRET: LIVEKIT.apiSecret,
      LIVEKIT_AGENT_NAME: LIVEKIT.agentName,
    })
  ).voiceTokens;
});
after(() => rm(root, { recursive: true, force: true }));

/** The agent-server calls the token route makes: the conversation and the warm-up. */
const agentServer = {
  conversation: async (id: string) => ({ id, title: 'Chat', updatedAt: null }),
  warm: async () => {},
} as unknown as AgentServerClient;

function fixture() {
  const app = new Hono();
  app.route(
    '/api/voice',
    createVoiceRoutes({
      agentServer,
      voiceTokens,
      voiceGatewayToken: VOICE_TOKEN,
    })
  );
  return app;
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** The claims this test reads from a LiveKit access token. */
interface Claims {
  exp: number;
  video: {
    room: string;
    roomJoin?: boolean;
    canPublish?: boolean;
    canPublishData?: boolean;
    canSubscribe?: boolean;
  };
  roomConfig?: { agents: Array<{ agentName: string; metadata: string }> };
}

/** The claims of a LiveKit access token (the signature is not checked here). */
function claimsOf(jwt: string): Claims {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Claims;
}

test('a call token joins a fresh room and dispatches the voice agent with the conversation', async () => {
  const response = await fixture().request(
    'https://gateway.test/api/voice/token',
    post({ conversationId: 'c1' })
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = (await response.json()) as {
    serverUrl: string;
    roomName: string;
    participantToken: string;
    conversation: { id: string };
  };
  assert.equal(body.serverUrl, LIVEKIT.url);
  assert.equal(body.conversation.id, 'c1');
  assert.match(body.roomName, /^call-c1-[0-9a-f]{8}$/);

  const claims = claimsOf(body.participantToken);
  assert.equal(claims.video.room, body.roomName);
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canPublish, true);
  assert.equal(claims.video.canPublishData, true);
  assert.equal(claims.video.canSubscribe, true);
  assert.ok(Math.abs(claims.exp - (Date.now() / 1000 + 30 * 60)) < 60, 'calls last 30 minutes');

  const dispatch = claims.roomConfig?.agents[0];
  assert.ok(dispatch);
  assert.equal(dispatch.agentName, 'assistant');
  assert.deepEqual(JSON.parse(dispatch.metadata), {
    [VOICE_DISPATCH_KEYS.conversationId]: 'c1',
    [VOICE_DISPATCH_KEYS.callMode]: 'short',
  });
});

test('a long call asks the agent to open in long mode, and only the dispatch keys are sent', async () => {
  const response = await fixture().request(
    'https://gateway.test/api/voice/token',
    post({ conversationId: 'c2', mode: 'long' })
  );
  const body = (await response.json()) as { participantToken: string };
  const dispatch = claimsOf(body.participantToken).roomConfig?.agents[0];
  assert.ok(dispatch);
  const metadata = JSON.parse(dispatch.metadata) as Record<string, unknown>;
  assert.deepEqual(Object.keys(metadata).sort(), Object.values(VOICE_DISPATCH_KEYS).sort());
  assert.equal(metadata[VOICE_DISPATCH_KEYS.callMode], 'long');
});

test('a warm-up token joins a room with no agent and no conversation', async () => {
  const response = await fixture().request('https://gateway.test/api/voice/token', post({}));
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    roomName: string;
    conversation: null;
    participantToken: string;
  };
  assert.equal(body.conversation, null);
  assert.match(body.roomName, /^warmup-/);
  const claims = claimsOf(body.participantToken);
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canPublish, undefined);
  assert.equal(claims.roomConfig, undefined);
  assert.ok(Math.abs(claims.exp - (Date.now() / 1000 + 5 * 60)) < 60, 'warm-ups last 5 minutes');
});

test('invalid token requests are refused before a token is minted', async () => {
  const app = fixture();
  for (const body of [{ mode: 'medium', conversationId: 'c1' }, { conversationId: 42 }, ['c1']]) {
    assert.equal(
      (await app.request('https://gateway.test/api/voice/token', post(body))).status,
      400
    );
  }
});

test('the voice agent endpoints refuse anything but the voice token', async () => {
  const app = fixture();
  const url = 'https://gateway.test/api/voice/conversations/c1/call/state';
  assert.equal((await app.request(url)).status, 401);
  assert.equal((await app.request(url, { headers: { Authorization: 'Bearer nope' } })).status, 401);
});
