import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const pnpmExecutable = 'pnpm';
// One Python pin for every Python check: apps/voice-agent/.python-version (also read by CI).
const pythonVersion = readFileSync(new URL('../apps/voice-agent/.python-version', import.meta.url), 'utf8').trim();
// The device client lints with the ruff version that apps/voice-agent/uv.lock resolves, so the
// version exists in one place. The lock format is `name = "ruff"` followed by `version = "..."`.
const lockedRuffVersion = (() => {
  const lock = readFileSync(new URL('../apps/voice-agent/uv.lock', import.meta.url), 'utf8');
  const match = /name = "ruff"\r?\nversion = "([^"]+)"/.exec(lock);
  if (!match) throw new Error('ruff is not locked in apps/voice-agent/uv.lock');
  return match[1];
})();
// The Gradle wrapper is a .bat on Windows; it runs through cmd.exe like pnpm does.
const gradleExecutable = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const hasJdk = spawnSync('java', ['-version'], { stdio: 'ignore', shell: false }).status === 0;

// Three test runners, each for one language: tsx --test for the TypeScript packages and apps
// (tsx resolves the @/ path alias in apps/web), pytest for apps/voice-agent, and unittest for
// the Python device client and the deploy scripts.
const commands = {
  gateway: [
    ['typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], 'apps/gateway'],
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
    // tsx is a root devDependency, so it is run from the root install.
    ['tests', process.execPath, ['../../node_modules/tsx/dist/cli.mjs', '--test', 'src/**/*.test.ts'], 'apps/web'],
  ],
  voice: [
    ['tests', 'uv', ['run', '--locked', '--group', 'dev', 'pytest'], 'apps/voice-agent'],
    ['lint', 'uv', ['run', '--locked', '--group', 'dev', 'ruff', 'check', 'src', 'tests'], 'apps/voice-agent'],
    ['typecheck', 'uv', ['run', '--locked', '--group', 'dev', 'pyright'], 'apps/voice-agent'],
  ],
  'device-client': [
    ['lint', 'uv', ['run', '--python', pythonVersion, '--no-project', '--with', `ruff==${lockedRuffVersion}`, 'ruff', 'check', '--config', 'ruff.toml', '.'], 'apps/device-client'],
    ['tests', 'uv', ['run', '--python', pythonVersion, '--no-project', '--no-sync', 'python', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], 'apps/device-client'],
  ],
  mobile: [
    // Needs a JDK and the Android SDK. Without a JDK each step is skipped with a message, not failed.
    ['assemble debug', hasJdk ? gradleExecutable : null, ['-PartemisMobileUrl=https://example.invalid', 'assembleDebug'], 'apps/mobile'],
    ['unit tests', hasJdk ? gradleExecutable : null, ['-PartemisMobileUrl=https://example.invalid', 'testDebugUnitTest'], 'apps/mobile'],
  ],
  packages: [
    ['typecheck', pnpmExecutable, ['run', 'typecheck:packages'], '.'],
    ['tests', pnpmExecutable, ['run', 'test:packages'], '.'],
  ],
  deploy: [
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
  for (const [label, executable, args, directory] of commands[group]) {
    process.stdout.write(`\n> ${group}: ${label}\n`);
    if (executable === null) {
      console.warn(`${group}: ${label} skipped, no Java JDK on PATH (install JDK 17 and the Android SDK to run it)`);
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
      env: process.env,
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
