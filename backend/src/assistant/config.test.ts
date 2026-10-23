import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateConfig } from './config.ts';

test('configuration rejects invalid ports', () => {
  assert.throws(() => validateConfig({ BACKEND_PORT: '0' }), /BACKEND_PORT/);
  assert.throws(() => validateConfig({ AGENT_SERVER_PORT: '0' }), /AGENT_SERVER_PORT/);
});

test('the gateway reaches the agent-server at AGENT_SERVER_URL with its shared token', () => {
  const config = validateConfig({
    AGENT_SERVER_URL: 'http://agent-server:4000',
    AGENT_SERVER_TOKEN: 'shared-token',
  });
  assert.deepEqual(config.agentServer, { url: 'http://agent-server:4000', token: 'shared-token' });
  assert.equal(validateConfig({ AGENT_SERVER_PORT: '4100' }).agentServer.url, 'http://127.0.0.1:4100');
});

test('production requires external roots and explicitly configured secrets', () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    WORKSPACE_PATH: join(tmpdir(), 'artemis-workspace'),
    ASSISTANT_DATA_ROOT: join(tmpdir(), 'artemis-data'),
    ARTEMIS_PASSWORD: 'long-password',
    ARTEMIS_DEVICE_TOKEN: 'device-token',
    AGENT_SERVER_TOKEN: 'private-agent-server-token',
    LIVEKIT_API_KEY: 'prodkey',
    LIVEKIT_API_SECRET: 'private-livekit-secret',
    VOICE_GATEWAY_TOKEN: 'private-voice-token',
  };
  assert.equal(validateConfig(env).workspace.dataDir, env.ASSISTANT_DATA_ROOT);
  assert.throws(
    () => validateConfig({ ...env, VOICE_GATEWAY_TOKEN: 'dev-voice-token-change-me' }),
    /VOICE_GATEWAY_TOKEN/
  );
  assert.throws(
    () => validateConfig({ ...env, AGENT_SERVER_TOKEN: undefined }),
    /AGENT_SERVER_TOKEN/
  );
  assert.throws(
    () =>
      validateConfig({
        ...env,
        ASSISTANT_DATA_ROOT: join(process.cwd(), 'backend', '.workspace', 'data'),
      }),
    /outside the repository/
  );
  assert.throws(
    () =>
      validateConfig({
        ...env,
        ASSISTANT_DATA_ROOT: join(env.WORKSPACE_PATH!, 'data'),
      }),
    /separate, non-overlapping roots/
  );
});

test('unset roots resolve to the documented host defaults without warnings', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  const defaults = validateConfig({});
  assert.equal(defaults.workspace.dir, join(repoRoot, 'backend', '.workspace'));
  assert.equal(defaults.workspace.dataDir, join(repoRoot, 'backend', '.workspace', 'data'));

  const explicit = join(tmpdir(), 'artemis-workspace');
  assert.equal(
    validateConfig({ WORKSPACE_PATH: explicit }).workspace.dataDir,
    join(explicit, 'data')
  );
  assert.equal(warn.mock.callCount(), 0);
});

test(
  'data-root containment resolves Windows case aliases and missing descendants',
  { skip: process.platform !== 'win32' },
  () => {
    const checkoutAlias = join(import.meta.dirname, '..', '..', '..').toUpperCase();
    assert.throws(
      () => validateConfig({ ASSISTANT_DATA_ROOT: join(checkoutAlias, 'BACKEND', 'NEW-DATA') }),
      /ASSISTANT_DATA_ROOT must be outside the repository checkout/
    );
  }
);
