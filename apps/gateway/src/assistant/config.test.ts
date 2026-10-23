import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateConfig } from './config.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const appsDir = join(import.meta.dirname, '..', '..', '..');

const productionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  WORKSPACE_PATH: join(tmpdir(), 'artemis-workspace'),
  ARTEMIS_DATA_DIR: join(tmpdir(), 'artemis-data'),
  ARTEMIS_PASSWORD: 'long-password',
  ARTEMIS_DEVICE_TOKEN: 'device-token',
  AGENT_SERVER_TOKEN: 'private-agent-server-token',
  LIVEKIT_API_KEY: 'prodkey',
  LIVEKIT_API_SECRET: 'private-livekit-secret',
  VOICE_GATEWAY_TOKEN: 'private-voice-token',
};

test('configuration rejects invalid ports', () => {
  assert.throws(() => validateConfig({ GATEWAY_PORT: '0' }), /GATEWAY_PORT/);
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

test('production requires explicit roots and explicitly configured secrets', () => {
  const env = productionEnv;
  assert.equal(validateConfig(env).workspace.dataDir, env.ARTEMIS_DATA_DIR);
  assert.throws(
    () => validateConfig({ ...env, VOICE_GATEWAY_TOKEN: 'dev-voice-token-change-me' }),
    /VOICE_GATEWAY_TOKEN/
  );
  assert.throws(
    () => validateConfig({ ...env, AGENT_SERVER_TOKEN: undefined }),
    /AGENT_SERVER_TOKEN/
  );
  assert.throws(
    () => validateConfig({ ...env, ARTEMIS_DATA_DIR: undefined }),
    /Production requires explicit WORKSPACE_PATH and ARTEMIS_DATA_DIR/
  );
  assert.throws(
    () => validateConfig({ ...env, ARTEMIS_DATA_DIR: join(appsDir, 'gateway', 'data') }),
    /must not be inside apps\//
  );
  assert.throws(
    () => validateConfig({ ...env, WORKSPACE_PATH: join(appsDir, 'gateway', 'workspace') }),
    /must not be inside apps\//
  );
  assert.throws(
    () =>
      validateConfig({
        ...env,
        ARTEMIS_DATA_DIR: join(env.WORKSPACE_PATH!, 'data'),
      }),
    /separate, non-overlapping roots/
  );
});

test('outside apps/ is the only production containment rule for runtime roots', () => {
  const env = { ...productionEnv, ARTEMIS_DATA_DIR: join(repoRoot, 'data', 'gateway') };
  assert.equal(validateConfig(env).workspace.dataDir, join(repoRoot, 'data', 'gateway'));
  assert.equal(
    validateConfig({ ...env, ARTEMIS_DATA_DIR: join(repoRoot, 'data-prod') }).workspace.dataDir,
    join(repoRoot, 'data-prod')
  );
});

test('unset roots resolve to the documented development defaults without warnings', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const defaults = validateConfig({});
  assert.equal(defaults.workspace.dir, join(repoRoot, 'data', 'workspace'));
  assert.equal(defaults.workspace.dataDir, join(repoRoot, 'data', 'gateway'));

  const explicit = join(tmpdir(), 'artemis-workspace');
  assert.equal(
    validateConfig({ WORKSPACE_PATH: explicit }).workspace.dataDir,
    join(repoRoot, 'data', 'gateway')
  );
  assert.equal(warn.mock.callCount(), 0);
});

test(
  'production containment resolves Windows case aliases and missing descendants',
  { skip: process.platform !== 'win32' },
  () => {
    const appsAlias = appsDir.toUpperCase();
    assert.throws(
      () =>
        validateConfig({
          ...productionEnv,
          ARTEMIS_DATA_DIR: join(appsAlias, 'GATEWAY', 'NEW-DATA'),
        }),
      /must not be inside apps\//
    );
  }
);
