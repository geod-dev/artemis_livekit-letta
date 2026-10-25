// Checks the deployment inputs that Compose cannot check by itself:
// 1. WORKSPACE_PATH and ARTEMIS_DATA_DIR, when set, are absolute, outside apps/, and not overlapping.
// 2. The base stack and the Coolify stack render the same services, apart from the differences below.
// Run from anywhere; needs the Docker CLI with Compose v2 and the variables the stacks require.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseFile = 'docker-compose.yml';
const coolifyFile = 'docker-compose.coolify.yml';

// The only differences the Coolify stack may have. Anything else that differs fails the check.
//   ports:      Coolify routes web and signaling through its own proxy and publishes only the LiveKit media ports.
//   host paths: Coolify uses fixed /data/artemis folders; the base file uses WORKSPACE_PATH and ARTEMIS_DATA_DIR.
const DOCUMENTED_DIFFERENCES = ['ports', 'volumes[].source'];

const MAX_REPORTED = 50;

function render(file) {
  const result = spawnSync('docker', ['compose', '-f', file, 'config', '--format', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
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

function hostRootProblems(env) {
  const problems = [];
  const appsDir = path.join(repoRoot, 'apps');
  const roots = [
    ['WORKSPACE_PATH', env.WORKSPACE_PATH],
    ['ARTEMIS_DATA_DIR', env.ARTEMIS_DATA_DIR],
  ].filter(([, value]) => value !== undefined && value !== '');

  for (const [name, value] of roots) {
    if (!path.isAbsolute(value)) problems.push(`${name} must be an absolute path (got ${value})`);
    const resolved = path.resolve(value);
    if (resolved === appsDir || resolved.startsWith(appsDir + path.sep)) {
      problems.push(`${name} must be outside apps/ (got ${value})`);
    }
  }

  const resolved = roots.map(([name, value]) => [name, path.resolve(value)]);
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const [nameA, a] = resolved[i];
      const [nameB, b] = resolved[j];
      if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
        problems.push(`${nameA} and ${nameB} overlap (${a}, ${b})`);
      }
    }
  }
  return problems;
}

function main() {
  const problems = hostRootProblems(process.env);
  try {
    const base = normalise(render(baseFile));
    const coolify = normalise(render(coolifyFile));
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

main();
