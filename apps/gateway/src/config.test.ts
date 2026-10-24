import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateConfig } from './config.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const appsDir = join(import.meta.dirname, '..', '..');

/** The secrets a production start refuses unless they are configured for real. */
const PRODUCTION_SECRETS = [
  'ARTEMIS_PASSWORD',
  'ARTEMIS_DEVICE_TOKEN',
  'AGENT_SERVER_TOKEN',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'VOICE_GATEWAY_TOKEN',
] as const;

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
  AGENT_SERVER_URL: 'http://agent-server:4000',
  MCP_DEVICE_BASE_URL: 'http://gateway:3000',
  LIVEKIT_URL: 'ws://livekit:7880',
};

/** The KEY=VALUE pairs of .env.example, as the repository ships them. */
function exampleEnv(): Record<string, string> {
  const pairs = readFileSync(join(repoRoot, '.env.example'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
    });
  return Object.fromEntries(pairs);
}

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
  assert.equal(
    validateConfig({ AGENT_SERVER_PORT: '4100' }).agentServer.url,
    'http://127.0.0.1:4100'
  );
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

test('production refuses every placeholder secret that .env.example ships', () => {
  const example = exampleEnv();
  for (const name of PRODUCTION_SECRETS) {
    assert.throws(
      () => validateConfig({ ...productionEnv, [name]: example[name] ?? '' }),
      new RegExp(name),
      `${name} from .env.example must not start a production gateway`
    );
  }
});

test('production refuses change-me and dev- prefixed secrets, and accepts real ones', () => {
  assert.throws(
    () => validateConfig({ ...productionEnv, ARTEMIS_DEVICE_TOKEN: 'change-me-device' }),
    /ARTEMIS_DEVICE_TOKEN/
  );
  assert.throws(
    () => validateConfig({ ...productionEnv, LIVEKIT_API_KEY: 'devkey' }),
    /LIVEKIT_API_KEY/
  );
  assert.equal(validateConfig(productionEnv).livekit.apiKey, 'prodkey');
});

test('production requires the service addresses, and no loopback default stands in for them', () => {
  for (const name of ['AGENT_SERVER_URL', 'MCP_DEVICE_BASE_URL', 'LIVEKIT_URL'] as const) {
    const env = { ...productionEnv, [name]: undefined };
    assert.throws(() => validateConfig(env), new RegExp(`${name} must be set in production`));
  }
});

test('service addresses must be absolute http(s) or ws(s) URLs, in every mode', () => {
  assert.throws(
    () => validateConfig({ MCP_DEVICE_BASE_URL: '/gateway' }),
    /MCP_DEVICE_BASE_URL must be an absolute URL/
  );
  assert.throws(
    () => validateConfig({ AGENT_SERVER_URL: 'ftp://agent-server:4000' }),
    /AGENT_SERVER_URL must be an http\(s\) or ws\(s\) URL/
  );
  assert.throws(() => validateConfig({ LIVEKIT_URL: 'javascript:alert(1)' }), /LIVEKIT_URL/);
  assert.equal(
    validateConfig({ MCP_DEVICE_BASE_URL: 'https://gateway.example/' }).deviceBaseUrl,
    'https://gateway.example'
  );
});

test('production secrets must all differ from each other', () => {
  assert.throws(
    () =>
      validateConfig({ ...productionEnv, ARTEMIS_DEVICE_TOKEN: productionEnv.ARTEMIS_PASSWORD }),
    /Production secrets must all differ/
  );
  assert.throws(
    () =>
      validateConfig({
        ...productionEnv,
        VOICE_GATEWAY_TOKEN: productionEnv.AGENT_SERVER_TOKEN,
      }),
    /Production secrets must all differ/
  );
});

test('the workspace and data roots must not overlap, even when only one is set', () => {
  const dataDir = join(repoRoot, 'data', 'gateway');
  assert.throws(
    () => validateConfig({ WORKSPACE_PATH: dataDir }),
    /must be separate, non-overlapping roots/
  );
  assert.throws(
    () => validateConfig({ WORKSPACE_PATH: join(repoRoot, 'data'), ARTEMIS_DATA_DIR: dataDir }),
    /must be separate, non-overlapping roots/
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

test('unset roots resolve to the documented development defaults', () => {
  const defaults = validateConfig({});
  assert.equal(defaults.workspace.dir, join(repoRoot, 'data', 'workspace'));
  assert.equal(defaults.workspace.dataDir, join(repoRoot, 'data', 'gateway'));

  const explicit = join(tmpdir(), 'artemis-workspace');
  assert.equal(
    validateConfig({ WORKSPACE_PATH: explicit }).workspace.dataDir,
    join(repoRoot, 'data', 'gateway')
  );
});

test('production containment follows a symlink or junction into apps/ to the real path', () => {
  const root = mkdtempSync(join(tmpdir(), 'artemis-config-'));
  try {
    const alias = join(root, 'alias');
    // A junction needs no privilege on Windows; a directory symlink does everywhere else.
    symlinkSync(appsDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () =>
        validateConfig({
          ...productionEnv,
          ARTEMIS_DATA_DIR: join(alias, 'gateway', 'NEW-DATA'),
        }),
      /must not be inside apps\//
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('IP_ADDRESS fills the defaults, and no literal placeholder is substituted', () => {
  const config = validateConfig({
    IP_ADDRESS: '10.20.30.40',
    LIVEKIT_URL: 'ws://${IP_ADDRESS}:7880',
  });
  assert.equal(config.livekit.url, 'ws://${IP_ADDRESS}:7880');
  assert.equal(validateConfig({ IP_ADDRESS: '10.20.30.40' }).livekit.url, 'ws://10.20.30.40:7880');
});
