import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const pnpmExecutable = 'pnpm';
// One Python pin for every Python check: apps/voice-agent/.python-version (also read by CI).
const pythonVersion = readFileSync(new URL('../apps/voice-agent/.python-version', import.meta.url), 'utf8').trim();
// The Gradle wrapper is a .bat on Windows; it runs through cmd.exe like pnpm does.
const gradleExecutable = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const hasJdk = spawnSync('java', ['-version'], { stdio: 'ignore', shell: false }).status === 0;
// Without a JDK the mobile group fails unless the caller opts out (decision 16).
const skipMobile = process.env.CHECK_SKIP_MOBILE === '1';

/**
 * The Python pins must agree: `requires-python` in apps/voice-agent/pyproject.toml and the Python
 * tag on every FROM line of apps/voice-agent/Dockerfile must name the .python-version pin.
 * Returns one message per mismatch (none when they agree).
 */
function pythonPinProblems() {
  const pinned = pythonVersion.split('.').slice(0, 2).join('.');
  const problems = [];
  const pyproject = readFileSync(new URL('../apps/voice-agent/pyproject.toml', import.meta.url), 'utf8');
  const requires = /^requires-python\s*=\s*">=\s*(\d+\.\d+)"/m.exec(pyproject);
  if (requires?.[1] !== pinned) {
    problems.push(`apps/voice-agent/pyproject.toml requires-python must be ">=${pinned}" (found ${requires?.[1] ?? 'nothing'})`);
  }
  const dockerfile = readFileSync(new URL('../apps/voice-agent/Dockerfile', import.meta.url), 'utf8');
  for (const line of dockerfile.split(/\r?\n/).filter((text) => /^\s*FROM\s/i.test(text))) {
    const tag = /python:?(\d+\.\d+)/.exec(line);
    if (tag?.[1] !== pinned) problems.push(`apps/voice-agent/Dockerfile must use Python ${pinned} (found: ${line.trim()})`);
  }
  return problems;
}

// Placeholders so `docker compose config` can interpolate the required variables when this check
// runs without a .env file. A real value in the environment or .env wins. Mirrors the compose job
// in .github/workflows/ci.yml, which must stay in step with the `:?` variables in the compose files.
const COMPOSE_PLACEHOLDERS = {
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

// Each group lists [label, executable, args, directory, env]. An executable that is a function runs in
// this process and returns its problem messages; a null executable is a step that cannot run here.
// The optional env holds defaults for the step; variables already set in the environment win.
const commands = {
  gateway: [
    ['typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], 'apps/gateway'],
    ['format', process.execPath, ['node_modules/prettier/bin/prettier.cjs', '--check', '.'], 'apps/gateway'],
    ['lint', process.execPath, ['node_modules/eslint/bin/eslint.js', '.'], 'apps/gateway'],
    ['tests', process.execPath, ['node_modules/tsx/dist/cli.mjs', '--test', 'src/**/*.test.ts'], 'apps/gateway'],
  ],
  'agent-server': [
    ['typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'], 'apps/agent-server'],
    ['tests', process.execPath, ['node_modules/tsx/dist/cli.mjs', '--test', 'src/**/*.test.ts'], 'apps/agent-server'],
  ],
  web: [
    ['typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'], 'apps/web'],
    ['typecheck node config', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.node.json'], 'apps/web'],
    ['typecheck tests', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.test.json'], 'apps/web'],
    ['format', process.execPath, ['node_modules/prettier/bin/prettier.cjs', '--check', '.'], 'apps/web'],
    ['lint', process.execPath, ['node_modules/eslint/bin/eslint.js', '.'], 'apps/web'],
    // tsx is the web app's own devDependency, so its CLI is run from apps/web.
    ['tests', process.execPath, ['node_modules/tsx/dist/cli.mjs', '--test', 'src/**/*.test.ts'], 'apps/web'],
  ],
  'voice-agent': [
    ['python pins', pythonPinProblems, [], '.'],
    ['format', 'uv', ['run', '--locked', '--group', 'dev', 'ruff', 'format', '--check', 'src', 'tests'], 'apps/voice-agent'],
    ['lint', 'uv', ['run', '--locked', '--group', 'dev', 'ruff', 'check', 'src', 'tests'], 'apps/voice-agent'],
    ['typecheck', 'uv', ['run', '--locked', '--group', 'dev', 'pyright'], 'apps/voice-agent'],
    ['tests', 'uv', ['run', '--locked', '--group', 'dev', 'pytest'], 'apps/voice-agent'],
  ],
  'device-client': [
    ['format', 'uv', ['run', '--python', pythonVersion, '--locked', '--group', 'dev', 'ruff', 'format', '--check', '.'], 'apps/device-client'],
    ['lint', 'uv', ['run', '--python', pythonVersion, '--locked', '--group', 'dev', 'ruff', 'check', '.'], 'apps/device-client'],
    ['tests', 'uv', ['run', '--python', pythonVersion, '--locked', '--group', 'dev', 'pytest'], 'apps/device-client'],
  ],
  mobile: [
    // Needs a JDK and the Android SDK. Without a JDK the step fails unless CHECK_SKIP_MOBILE=1 (decision 16).
    ['assemble debug', hasJdk ? gradleExecutable : null, ['-PartemisMobileUrl=https://example.invalid', 'assembleDebug'], 'apps/mobile'],
    ['unit tests', hasJdk ? gradleExecutable : null, ['-PartemisMobileUrl=https://example.invalid', 'testDebugUnitTest'], 'apps/mobile'],
    ['lint debug', hasJdk ? gradleExecutable : null, ['-PartemisMobileUrl=https://example.invalid', 'lintDebug'], 'apps/mobile'],
  ],
  packages: [
    ['typecheck', pnpmExecutable, ['run', 'typecheck:packages'], '.'],
    ['tests', pnpmExecutable, ['run', 'test:packages'], '.'],
  ],
  deploy: [
    ['compose host roots and Coolify parity', process.execPath, ['scripts/check-compose.mjs'], '.', COMPOSE_PLACEHOLDERS],
    ['mocked deployment tests', 'uv', ['run', '--python', pythonVersion, '--no-project', '--no-sync', 'python', '-m', 'unittest', 'discover', '-s', 'deploy/coolify', '-p', 'test_*.py'], '.'],
    ['sh syntax https', 'sh', ['-n', 'deploy/https/setup.sh'], '.'],
    ['sh syntax postgres', 'sh', ['-n', 'deploy/postgres/init-databases.sh'], '.'],
    ['sh syntax postgres entrypoint', 'sh', ['-n', 'deploy/postgres/entrypoint.sh'], '.'],
  ],
  schema: [
    ['present schema drift', process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/generate-present-tool.ts', '--check'], '.'],
    ['typecheck generator', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'scripts/tsconfig.json'], '.'],
  ],
  boundaries: [
    ['dependency rules', process.execPath, ['scripts/check-boundaries.mjs'], '.'],
    ['dependency rules self-test', process.execPath, ['scripts/check-boundaries.mjs', '--self-test'], '.'],
  ],
};

const selected = process.argv[2];
// Every group in `commands`, in declaration order, so the default run covers each group exactly once.
const defaultGroups = Object.keys(commands);
const groups = selected === 'all' || selected === undefined ? defaultGroups : [selected];

if (groups.some((group) => !(group in commands))) {
  console.error(`Unknown check group: ${selected}`);
  console.error(`Choose one of: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}

if (!process.env.TEST_DATABASE_URL) {
  console.warn('WARNING: TEST_DATABASE_URL is not set, so the Postgres integration tests are being skipped. Set TEST_DATABASE_URL to a Postgres server admin URL (suites create and drop their own databases) to run them.');
}

let failed = false;
for (const group of groups) {
  for (const [label, executable, args, directory, defaults = {}] of commands[group]) {
    process.stdout.write(`\n> ${group}: ${label}\n`);
    if (typeof executable === 'function') {
      const problems = executable();
      for (const problem of problems) console.error(`${group}: ${label}: ${problem}`);
      if (problems.length > 0) failed = true;
      continue;
    }
    if (executable === null) {
      if (skipMobile) {
        console.warn(`${group}: ${label} skipped (CHECK_SKIP_MOBILE=1); no Java JDK on PATH`);
      } else {
        console.error(`${group}: ${label} cannot run: no Java JDK on PATH (install JDK 17 and the Android SDK, or set CHECK_SKIP_MOBILE=1 to skip)`);
        failed = true;
      }
      continue;
    }
    // On Windows, pnpm and the Gradle wrapper are .cmd/.bat shims, so run them through cmd.exe without the shell option.
    const viaCmd = process.platform === 'win32' && (executable === pnpmExecutable || executable === gradleExecutable);
    const command = viaCmd ? (process.env.ComSpec || 'cmd.exe') : executable;
    const commandArgs = viaCmd ? ['/d', '/s', '/c', executable, ...args] : args;
    const result = spawnSync(command, commandArgs, {
      cwd: new URL(`../${directory}/`, import.meta.url),
      stdio: 'inherit',
      shell: false,
      windowsVerbatimArguments: viaCmd,
      env: { ...defaults, ...process.env },
    });
    if (result.error) {
      console.error(`${group}: ${label} could not start: ${result.error.message}`);
      failed = true;
    } else if (result.status !== 0) {
      console.error(`${group}: ${label} failed with exit code ${result.status ?? 'unknown'}`);
      failed = true;
    }
  }
}

process.exitCode = failed ? 1 : 0;
