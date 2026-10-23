import { spawnSync } from 'node:child_process';
import process from 'node:process';

const pnpmExecutable = 'pnpm';

const commands = {
  backend: [
    ['typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], 'backend'],
    ['lint', process.execPath, ['node_modules/eslint/bin/eslint.js', '.'], 'backend'],
    ['tests', process.execPath, ['node_modules/tsx/dist/cli.mjs', '--test', 'src/**/*.test.ts'], 'backend'],
  ],
  frontend: [
    ['typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], 'frontend'],
    ['lint', process.execPath, ['node_modules/eslint/bin/eslint.js', '.'], 'frontend'],
    ['tests', process.execPath, ['--test', '--experimental-strip-types', '--no-warnings', 'src/**/*.test.ts'], 'frontend'],
  ],
  voice: [
    ['tests', 'uv', ['run', '--locked', '--group', 'dev', 'pytest'], 'voice-agent'],
    ['lint', 'uv', ['run', '--locked', '--group', 'dev', 'ruff', 'check', 'src', 'tests'], 'voice-agent'],
    ['typecheck', 'uv', ['run', '--locked', '--group', 'dev', 'pyright'], 'voice-agent'],
  ],
  devices: [
    ['tests', 'uv', ['run', '--python', '3.13', '--no-project', '--no-sync', 'python', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_device.py'], 'devices'],
  ],
  packages: [
    ['typecheck', pnpmExecutable, ['run', 'typecheck:packages'], '.'],
    ['tests', pnpmExecutable, ['run', 'test:packages'], '.'],
  ],
  operations: [
    ['mocked deployment tests', 'uv', ['run', '--python', '3.13', '--no-project', '--no-sync', 'python', '-m', 'unittest', 'discover', '-s', 'infrastructure/coolify', '-p', 'test_*.py'], '.'],
  ],
  schema: [
    ['present schema drift', process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/generate-present-tool.ts', '--check'], '.'],
  ],
};

const selected = process.argv[2];
const groups = selected === 'all'
  ? ['backend', 'frontend', 'voice', 'devices', 'packages', 'operations', 'schema']
  : selected === undefined
    ? ['backend', 'frontend', 'voice', 'devices', 'packages', 'operations', 'schema']
    : [selected];

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
