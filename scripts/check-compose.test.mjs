// Unit tests for the host-root rules in check-compose.mjs. Run with: node --test scripts/check-compose.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeEnv, hostRootProblems, parseDotEnv, rootSource, ROOT_VARIABLES, COMPOSE_PLACEHOLDERS } from './check-compose.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appsDir = path.join(repoRoot, 'apps');
const insideApps = path.join(appsDir, 'workspace');
const workspace = path.join(repoRoot, '..', 'artemis-workspace');
const gatewayData = path.join(repoRoot, '..', 'artemis-gateway-data');

// Runs the same resolution the check does for both variables.
function problemsFor(processEnv, dotEnv) {
  return hostRootProblems(ROOT_VARIABLES.map((name) => rootSource(name, processEnv, dotEnv)), appsDir);
}

test('separate absolute roots outside apps/ pass', () => {
  assert.deepEqual(problemsFor({ WORKSPACE_PATH: workspace, ARTEMIS_DATA_DIR: gatewayData }, {}), []);
});

test('a root under apps/ fails, and so does apps/ itself', () => {
  const underApps = problemsFor({ WORKSPACE_PATH: insideApps, ARTEMIS_DATA_DIR: gatewayData }, {});
  assert.deepEqual(underApps, ['WORKSPACE_PATH (from the process environment) must be outside apps/']);
  assert.deepEqual(problemsFor({ WORKSPACE_PATH: workspace, ARTEMIS_DATA_DIR: appsDir }, {}), [
    'ARTEMIS_DATA_DIR (from the process environment) must be outside apps/',
  ]);
});

test('a relative root fails because Compose would resolve it against the repo', () => {
  assert.deepEqual(problemsFor({ WORKSPACE_PATH: 'data/workspace', ARTEMIS_DATA_DIR: gatewayData }, {}), [
    'WORKSPACE_PATH (from the process environment) must be an absolute path',
  ]);
});

test('overlapping roots fail when equal or nested, in either order', () => {
  const nested = path.join(workspace, 'gateway');
  assert.deepEqual(problemsFor({ WORKSPACE_PATH: workspace, ARTEMIS_DATA_DIR: workspace }, {}), [
    'WORKSPACE_PATH (from the process environment) and ARTEMIS_DATA_DIR (from the process environment) overlap',
  ]);
  assert.deepEqual(problemsFor({ WORKSPACE_PATH: workspace, ARTEMIS_DATA_DIR: nested }, {}), [
    'WORKSPACE_PATH (from the process environment) and ARTEMIS_DATA_DIR (from the process environment) overlap',
  ]);
  assert.deepEqual(problemsFor({ WORKSPACE_PATH: nested, ARTEMIS_DATA_DIR: workspace }, {}), [
    'WORKSPACE_PATH (from the process environment) and ARTEMIS_DATA_DIR (from the process environment) overlap',
  ]);
});

test('a root set only in .env is checked, and the message names .env without the value', () => {
  const dotEnv = parseDotEnv(`WORKSPACE_PATH=${insideApps}\nARTEMIS_DATA_DIR=${gatewayData}\n`);
  const problems = problemsFor({}, dotEnv);

  assert.deepEqual(problems, ['WORKSPACE_PATH (from .env) must be outside apps/']);
  assert.ok(!problems.join('\n').includes(insideApps), 'the problem message must not print the value');
});

test('an overlap between a process-environment root and a .env root is caught', () => {
  const dotEnv = parseDotEnv(`ARTEMIS_DATA_DIR=${path.join(workspace, 'data')}\n`);

  assert.deepEqual(problemsFor({ WORKSPACE_PATH: workspace }, dotEnv), [
    'WORKSPACE_PATH (from the process environment) and ARTEMIS_DATA_DIR (from .env) overlap',
  ]);
});

test('the process environment wins over .env, as it does for Compose', () => {
  const dotEnv = parseDotEnv(`WORKSPACE_PATH=${insideApps}\nARTEMIS_DATA_DIR=${gatewayData}\n`);

  assert.deepEqual(problemsFor({ WORKSPACE_PATH: workspace }, dotEnv), []);
  assert.equal(rootSource('WORKSPACE_PATH', { WORKSPACE_PATH: workspace }, dotEnv).source, 'the process environment');
});

test('a variable set nowhere falls back to the CI placeholder, which is valid', () => {
  const root = rootSource('ARTEMIS_DATA_DIR', {}, {});

  assert.equal(root.value, COMPOSE_PLACEHOLDERS.ARTEMIS_DATA_DIR);
  assert.equal(root.source, 'the CI placeholder');
  assert.deepEqual(problemsFor({}, {}), []);
});

test('an empty root is left to Compose defaults and is not checked', () => {
  assert.deepEqual(problemsFor({ WORKSPACE_PATH: '', ARTEMIS_DATA_DIR: gatewayData }, {}), []);
});

test('composeEnv adds placeholders only for variables that neither the environment nor .env sets', () => {
  const env = composeEnv({ POSTGRES_PASSWORD: 'from-process' }, parseDotEnv(`WORKSPACE_PATH=${workspace}\n`));

  assert.equal(env.POSTGRES_PASSWORD, 'from-process');
  assert.equal(env.WORKSPACE_PATH, undefined, '.env must be left for Compose to read');
  assert.equal(env.ARTEMIS_DATA_DIR, COMPOSE_PLACEHOLDERS.ARTEMIS_DATA_DIR);
  assert.equal(env.LIVEKIT_API_KEY, COMPOSE_PLACEHOLDERS.LIVEKIT_API_KEY);
});

test('parseDotEnv reads quoted values, export lines and comments', () => {
  const parsed = parseDotEnv(
    ['# comment', '', 'export A=1', 'B="two words"', "C='three'", 'D=four # trailing', ' E = five '].join('\n')
  );

  assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'three', D: 'four', E: 'five' });
});
