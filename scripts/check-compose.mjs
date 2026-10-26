// Checks the deployment inputs that Compose cannot check by itself:
// 1. WORKSPACE_PATH and ARTEMIS_DATA_DIR, as Compose will interpolate them (process environment first, then the
//    repo .env, then the CI placeholder): absolute, outside apps/, and not overlapping. Values are never printed.
// 2. The base stack and the Coolify stack render the same services, apart from the differences below.
// Run from anywhere; needs the Docker CLI with Compose v2. The unit tests live in check-compose.test.mjs.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dotEnvFile = path.join(repoRoot, '.env');
const baseFile = 'docker-compose.yml';
const coolifyFile = 'docker-compose.coolify.yml';

// The only differences the Coolify stack may have. Anything else that differs fails the check.
//   ports:      Coolify routes web and signaling through its own proxy and publishes only the LiveKit media ports.
//   host paths: Coolify uses fixed /data/artemis folders; the base file uses WORKSPACE_PATH and ARTEMIS_DATA_DIR.
const DOCUMENTED_DIFFERENCES = ['ports', 'volumes[].source'];

const MAX_REPORTED = 50;

// Placeholders so `docker compose config` can interpolate the required variables when this check runs
// without a .env file. A real value in the process environment or .env always wins over a placeholder.
// Mirrors the compose job in .github/workflows/ci.yml, which must stay in step with the `:?` variables in the compose files.
export const COMPOSE_PLACEHOLDERS = {
  POSTGRES_PASSWORD: 'ci-placeholder',
  ARTEMIS_DB_PASSWORD: 'ci-placeholder',
  HINDSIGHT_DB_PASSWORD: 'ci-placeholder',
  HINDSIGHT_API_KEY: 'ci-placeholder',
  ANTHROPIC_API_KEY: 'ci-placeholder',
  AGENT_SERVER_TOKEN: 'ci-placeholder',
  ARTEMIS_PASSWORD: 'ci-placeholder',
  ARTEMIS_DEVICE_TOKEN: 'ci-placeholder',
  VOICE_GATEWAY_TOKEN: 'ci-placeholder',
  LIVEKIT_API_KEY: 'ci-placeholder',
  LIVEKIT_API_SECRET: 'ci-placeholder',
  IP_ADDRESS: '127.0.0.1',
  LIVEKIT_PUBLIC_URL: 'wss://ci-placeholder.invalid/livekit',
  WORKSPACE_PATH: '/ci/workspace',
  ARTEMIS_DATA_DIR: '/ci/gateway-data',
};

// The host directories the base stack mounts, validated by hostRootProblems.
export const ROOT_VARIABLES = ['WORKSPACE_PATH', 'ARTEMIS_DATA_DIR'];

// Reads KEY=VALUE lines the way the Compose .env file is read (quotes and `export` allowed). Values are
// only ever handed to the checks in memory; nothing here prints them.
export function parseDotEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    values[match[1]] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '');
  }
  return values;
}

export function readDotEnv(file = dotEnvFile) {
  return existsSync(file) ? parseDotEnv(readFileSync(file, 'utf8')) : {};
}

// The value Compose will interpolate for one variable. The process environment wins over .env, and the
// placeholder applies only when neither sets the variable.
export function rootSource(name, processEnv, dotEnv) {
  if (name in processEnv) return { name, value: processEnv[name], source: 'the process environment' };
  if (name in dotEnv) return { name, value: dotEnv[name], source: '.env' };
  return { name, value: COMPOSE_PLACEHOLDERS[name], source: 'the CI placeholder' };
}

// The environment for the `docker compose config` runs: the process environment, plus a placeholder for each
// required variable that neither the process environment nor .env sets. Compose reads .env itself.
export function composeEnv(processEnv, dotEnv) {
  const env = { ...processEnv };
  for (const [name, value] of Object.entries(COMPOSE_PLACEHOLDERS)) {
    if (!(name in processEnv) && !(name in dotEnv)) env[name] = value;
  }
  return env;
}

// The canonical location of a path, so that 8.3 short names (ILUCAS~1), symlinks and case do not hide an
// overlap. Only the part that exists can be resolved; the rest of the path is kept as written.
function canonical(target) {
  let existing = target;
  const missing = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    // Keep the path as written when the OS will not resolve it.
  }
  const joined = path.join(real, ...missing);
  // Windows paths are case-insensitive, so apps/ and Apps\ are the same folder there.
  return process.platform === 'win32' ? joined.toLowerCase() : joined;
}

// Returns one message per problem with the given roots. A root is { name, value, source }; an empty or
// unset value means Compose uses its own default inside the repo, so it is not checked. Messages name the
// variable and where it came from, never its value.
export function hostRootProblems(roots, appsDir = path.join(repoRoot, 'apps')) {
  const key = canonical;
  const appsKey = key(path.resolve(appsDir));
  const set = roots
    .filter(({ value }) => value !== undefined && value !== '')
    .map((root) => ({ ...root, resolved: key(path.resolve(repoRoot, root.value)) }));
  const problems = [];

  for (const root of set) {
    const where = `${root.name} (from ${root.source})`;
    if (!path.isAbsolute(root.value)) problems.push(`${where} must be an absolute path`);
    if (root.resolved === appsKey || root.resolved.startsWith(appsKey + path.sep)) {
      problems.push(`${where} must be outside apps/`);
    }
  }

  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      const a = set[i];
      const b = set[j];
      if (a.resolved === b.resolved || a.resolved.startsWith(b.resolved + path.sep) || b.resolved.startsWith(a.resolved + path.sep)) {
        problems.push(`${a.name} (from ${a.source}) and ${b.name} (from ${b.source}) overlap`);
      }
    }
  }
  return problems;
}

function render(file, env) {
  const result = spawnSync('docker', ['compose', '-f', file, 'config', '--format', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || '').trim();
    throw new Error(`docker compose config failed for ${file}: ${detail}`);
  }
  return JSON.parse(result.stdout);
}

// Drops only the documented differences. Everything left is compared.
function normalise(config) {
  const services = {};
  for (const [name, service] of Object.entries(config.services ?? {})) {
    const { ports, ...rest } = service;
    rest.volumes = (rest.volumes ?? []).map(({ source, ...volume }) => volume);
    services[name] = rest;
  }
  return { ...config, services };
}

// Returns the paths at which two JSON values differ.
function differences(a, b, at = '$') {
  if (a === b) return [];
  const bothObjects = typeof a === 'object' && typeof b === 'object' && a !== null && b !== null;
  if (!bothObjects || Array.isArray(a) !== Array.isArray(b)) return [at];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((key) => differences(a[key], b[key], `${at}.${key}`));
}

function main() {
  const dotEnv = readDotEnv();
  const problems = hostRootProblems(ROOT_VARIABLES.map((name) => rootSource(name, process.env, dotEnv)));
  const env = composeEnv(process.env, dotEnv);
  try {
    const base = normalise(render(baseFile, env));
    const coolify = normalise(render(coolifyFile, env));
    const diffs = differences(base, coolify);
    for (const at of diffs.slice(0, MAX_REPORTED)) {
      problems.push(`base and Coolify stacks differ at ${at} (documented differences: ${DOCUMENTED_DIFFERENCES.join(', ')})`);
    }
    if (diffs.length > MAX_REPORTED) problems.push(`... and ${diffs.length - MAX_REPORTED} more differences`);
  } catch (error) {
    problems.push(error.message);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-compose: ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('check-compose: host roots are valid and the base and Coolify stacks match apart from the documented differences.');
}

// Importing this file (the unit tests do) must not run the Docker checks.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
