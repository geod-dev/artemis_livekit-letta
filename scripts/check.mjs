import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
    ['tests', 'uv', ['run', '--locked', '--group', 'dev', 'pytest'], 'agent'],
    ['lint', 'uv', ['run', '--locked', '--group', 'dev', 'ruff', 'check', 'src', 'tests'], 'agent'],
    ['typecheck', 'uv', ['run', '--locked', '--group', 'dev', 'pyright'], 'agent'],
  ],
  devices: [
    ['tests', 'uv', ['run', '--python', '3.13', '--no-project', '--no-sync', 'python', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_device.py'], 'devices'],
  ],
  letta: [['tests', process.execPath, ['--test', 'infrastructure/letta/extensions/*.test.mjs'], '.']],
  operations: [
    ['mocked deployment tests', 'uv', ['run', '--python', '3.13', '--no-project', '--no-sync', 'python', '-m', 'unittest', 'discover', '-s', 'infrastructure/coolify', '-p', 'test_*.py'], '.'],
  ],
  'letta-bundle': [
    ['pinned bundle regression tests', process.execPath, ['--test', 'infrastructure/letta/patching/groq-qwen.test.mjs'], '.'],
  ],
  schema: [
    ['present schema drift', process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/generate-present-tool.ts', '--check'], 'frontend'],
  ],
};

const selected = process.argv[2];
const groups = selected === 'all'
  ? ['backend', 'frontend', 'voice', 'devices', 'letta', 'letta-bundle', 'operations', 'schema']
  : selected === undefined
    ? ['backend', 'frontend', 'voice', 'devices', 'letta', 'letta-bundle', 'operations', 'schema']
    : [selected];

if (groups.some((group) => !(group in commands))) {
  console.error(`Unknown check group: ${selected}`);
  console.error(`Choose one of: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}

let failed = false;
for (const group of groups) {
  const checkEnvironment = { ...process.env };
  if (group === 'letta-bundle' && !checkEnvironment.LETTA_BUNDLE) {
    const bundle = new URL('../backend/node_modules/@letta-ai/letta-code/letta.js', import.meta.url);
    if (!existsSync(bundle)) {
      console.error('letta-bundle: install backend dependencies or set LETTA_BUNDLE to the pinned Letta 0.34.4 bundle path');
      failed = true;
      continue;
    }
    checkEnvironment.LETTA_BUNDLE = fileURLToPath(bundle);
  }
  for (const [label, executable, args, directory] of commands[group]) {
    process.stdout.write(`\n> ${group}: ${label}\n`);
    const result = spawnSync(executable, args, {
      cwd: new URL(`../${directory}/`, import.meta.url),
      stdio: 'inherit',
      shell: false,
      env: checkEnvironment,
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
