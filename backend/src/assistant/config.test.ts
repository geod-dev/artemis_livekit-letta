import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateConfig } from './config.ts';

test('configuration rejects invalid ports, reflection counts, and timezones', () => {
  assert.throws(() => validateConfig({ BACKEND_PORT: '0' }), /BACKEND_PORT/);
  assert.throws(
    () => validateConfig({ ASSISTANT_REFLECTION_STEPS: '-1' }),
    /ASSISTANT_REFLECTION_STEPS/
  );
  assert.throws(() => validateConfig({ ASSISTANT_TIMEZONE: 'Mars/Olympus' }), /IANA timezone/);
});

test('production requires external roots and explicitly configured secrets', () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    WORKSPACE_PATH: join(tmpdir(), 'artemis-workspace'),
    ASSISTANT_DATA_ROOT: join(tmpdir(), 'artemis-data'),
    ARTEMIS_PASSWORD: 'long-password',
    ARTEMIS_DEVICE_TOKEN: 'device-token',
    LETTA_SERVER_TOKEN: 'private-letta-token',
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
