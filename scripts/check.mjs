import { spawnSync } from 'node:child_process';
import process from 'node:process';

const pnpmExecutable = 'pnpm';

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
    ['typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], 'apps/web'],
    ['lint', process.execPath, ['node_modules/eslint/bin/eslint.js', '.'], 'apps/web'],
    ['tests', process.execPath, ['--test', '--experimental-strip-types', '--no-warnings', 'src/**/*.test.ts'], 'apps/web'],
  ],
  voice: [
    ['tests', 'uv', ['run', '--locked', '--group', 'dev', 'pytest'], 'apps/voice-agent'],
    ['lint', 'uv', ['run', '--locked', '--group', 'dev', 'ruff', 'check', 'src', 'tests'], 'apps/voice-agent'],
    ['typecheck', 'uv', ['run', '--locked', '--group', 'dev', 'pyright'], 'apps/voice-agent'],
  ],
  device: [
    ['tests', 'uv', ['run', '--python', '3.13', '--no-project', '--no-sync', 'python', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_device.py'], 'apps/device-client'],
  ],
  packages: [
    ['typecheck', pnpmExecutable, ['run', 'typecheck:packages'], '.'],
    ['tests', pnpmExecutable, ['run', 'test:packages'], '.'],
  ],
  deploy: [
    ['mocked deployment tests', 'uv', ['run', '--python', '3.13', '--no-project', '--no-sync', 'python', '-m', 'unittest', 'discover', '-s', 'deploy/coolify', '-p', 'test_*.py'], '.'],
  ],
  schema: [
    ['present schema drift', process.execPath, ['--experimental-strip-types', '--no-warnings', 'packages/contracts/scripts/generate-present-tool.ts', '--check'], '.'],
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
  console.warn('WARNING: TEST_DATABASE_URL is not set, so the Postgres integration tests are being skipped. Set TEST_DATABASE_URL to a Postgres database the tests may create tables in to run them.');
}

let failed = false;
for (const group of groups) {
  for (const [label, executable, args, directory] of commands[group]) {
    process.stdout.write(`\n> ${group}: ${label}\n`);
    // On Windows, pnpm is a .cmd shim, so run it through cmd.exe without the shell option.
    const viaCmd = process.platform === 'win32' && executable === pnpmExecutable;
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
