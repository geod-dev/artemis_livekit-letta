import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { patchBundle } from './worker-execution.mjs';
import { patchBundle as patchModels } from './model-requests.mjs';
import { patchBundle as patchTasks } from './task-control.mjs';

const original = readFileSync(process.env.LETTA_BUNDLE || new URL('../../../backend/node_modules/@letta-ai/letta-code/letta.js', import.meta.url), 'utf8');
const patched = patchBundle(original);

function extract(name, source = patched) {
  const marker = `function ${name}(`;
  const index = source.indexOf(marker);
  assert.ok(index >= 0, `Missing ${name}`);
  const start = source.slice(index - 6, index) === 'async ' ? index - 6 : index;
  const end = source.indexOf('\n}', index);
  assert.ok(end > index);
  return source.slice(start, end + 2);
}

function scope(role = 'subagent', depth = 1) {
  return {
    process: { env: {} },
    getRuntimeContext: () => ({ executionSettings: { agent_role: role } }),
    getRuntimeExecutionEnv: (_env, settings) => ({ LETTA_CODE_AGENT_ROLE: settings.agent_role }),
    getCurrentSubagentDepth: () => depth,
  };
}

// Exercise the published Bash implementation. Shell completion is controlled so
// the test can prove that no tool result escapes before exit, even with a live
// notification queue and an explicit run_in_background request.
function bashFixture(role = 'subagent', depth = 1, realShell = false) {
  let complete, reject, launchOptions;
  let notifications = 0;
  const processes = new Map();
  const context = {
    ...scope(role, depth),
    Map, Date,
    // The fake shell has no OS handle to keep Node alive as a real child does.
    setTimeout: (fn, ms) => { setTimeout(fn, ms); return { unref() {} }; },
    DEFAULT_FOREGROUND_YIELD_MS: 1,
    FOREGROUND_SLEEP_BLOCKED_MESSAGE: 'sleep blocked',
    INTERRUPTED_BY_USER: 'interrupted',
    LIMITS: {},
    validateRequiredParams() {},
    getCurrentWorkingDirectory: () => '/workspace',
    assertSafeWindowsCommand() {},
    getShellEnv: () => ({}),
    captureSecretRedactions: () => [],
    scrubSecretsFromString: (text) => text,
    createSecretStreamScrubber: () => ({ push: (text) => text, flush: () => '' }),
    backgroundProcesses: processes,
    commandRunsForegroundSleep: (command) => command.startsWith('sleep'),
    consumeWorkingDirectoryRecovery() {},
    assertBackgroundProcessCapacity() {},
    withStrictShellPrelude: (command) => command,
    getNextBashId: () => 'bash_1',
    createBackgroundOutputFile: () => '/tmp/test.log',
    getBackgroundLauncher: (command) => ['sh', '-c', command],
    noteExpectedWorktreeForLauncher() {},
    applyShellSandbox: (launcher, _cwd, env) => ({ launcher, env }),
    startShellProcess: (_launcher, options) => {
      launchOptions = options;
      if (realShell) {
        const child = spawn('sh', ['-c', options.sourceCommand], { signal: options.signal, timeout: options.timeoutMs });
        child.stdout.on('data', (chunk) => options.onOutput(String(chunk), 'stdout'));
        child.stderr.on('data', (chunk) => options.onOutput(String(chunk), 'stderr'));
        return { process: child, completion: new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', (exitCode) => resolve({ exitCode }));
        }) };
      }
      return { process: { kill() {} }, completion: new Promise((yes, no) => { complete = yes; reject = no; }) };
    },
    appendBackgroundProcessOutput() {},
    appendToOutputFile: () => true,
    resolveNotificationScope: () => ({}),
    scrubCompletedBackgroundOutput() {},
    notifyBackgroundCompletion: () => { notifications++; },
    scheduleBackgroundProcessCleanup() {},
    isQueueBridgeConnected: () => true,
    rmSync12() {},
    truncateByChars: (text) => ({ content: text }),
  };
  const bash = runInNewContext(extract('assistantWorkerExecution') + '\n' + extract('bash') + '\nbash', context);
  return {
    bash, processes,
    get launchOptions() { return launchOptions; },
    get notifications() { return notifications; },
    finish(output = '202910851145973522', exitCode = 0) {
      launchOptions.onOutput(output, 'stdout');
      complete({ exitCode });
    },
    fail(error) { reject(error); },
  };
}

test('worker sleep and explicit background requests wait for the actual result', async () => {
  for (const background of [false, true]) {
    const fixture = bashFixture();
    const signal = new AbortController().signal;
    let returned = false;
    const result = fixture.bash({ command: 'sleep 20 && python3 -c ...', run_in_background: background, foregroundYieldMs: 0, signal });
    result.then(() => { returned = true; });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(returned, false);
    assert.equal(fixture.launchOptions.signal, signal);
    assert.equal(fixture.launchOptions.timeoutMs, 120000);
    fixture.finish();
    const response = await result;
    assert.equal(response.status, 'success');
    assert.match(response.content[0].text, /^202910851145973522$/);
    assert.equal(fixture.processes.size, 0);
    assert.equal(fixture.notifications, 0);
  }
});

test('worker timeout, nonzero exit, and cancellation return errors instead of background receipts', async () => {
  for (const failure of ['timeout', 'exit', 'abort']) {
    const fixture = bashFixture();
    const controller = new AbortController();
    const pending = fixture.bash({ command: 'work', run_in_background: true, timeout: 900000, signal: controller.signal });
    assert.equal(fixture.launchOptions.timeoutMs, 600000);
    if (failure === 'timeout') fixture.fail(Object.assign(new Error('deadline'), { killed: true }));
    else if (failure === 'exit') fixture.finish('calculation failed', 1);
    else {
      controller.abort();
      fixture.fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }
    const response = await pending;
    assert.equal(response.status, 'error');
    assert.doesNotMatch(response.content[0].text, /task ID|running in background/);
    if (failure === 'abort') assert.equal(response.content[0].text, 'interrupted');
    assert.equal(fixture.notifications, 0);
  }
});

test('parent retains background execution, automatic yield, and foreground sleep restriction', async () => {
  const parent = bashFixture('primary', 0);
  assert.equal((await parent.bash({ command: 'sleep 20' })).status, 'error');
  const response = await parent.bash({ command: 'long command', foregroundYieldMs: 0 });
  assert.match(response.content[0].text, /still running with task ID/);
  parent.finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(parent.notifications, 1);
  const explicit = bashFixture('primary', 0);
  assert.match((await explicit.bash({ command: 'sleep 20', run_in_background: true })).content[0].text, /running in background/);
  explicit.finish();
});

test('worker shell integration: sleep 20 then calculate returns one completed result', { skip: process.platform === 'win32' }, async () => {
  const fixture = bashFixture('subagent', 1, true);
  const started = Date.now();
  const response = await fixture.bash({
    command: 'sleep 20 && python3 -c "print(489416498 * 414597489)"',
    run_in_background: true,
    foregroundYieldMs: 1,
  });
  assert.ok(Date.now() - started >= 20000);
  assert.equal(response.status, 'success');
  assert.equal(response.content[0].text.trim(), '202910851145973522');
  assert.equal(fixture.notifications, 0);
  assert.equal(fixture.processes.size, 0);
});

test('listener runtime identity and nested depth identify workers without changing process environment', async () => {
  for (const [role, depth, expected] of [['subagent', 0, true], ['primary', 1, true], ['primary', 0, false]]) {
    const isWorker = runInNewContext(extract('assistantWorkerExecution') + '\nassistantWorkerExecution', scope(role, depth));
    assert.equal(isWorker(), expected);
  }
});

test('worker external tools return their settled result, even if configured to background', async () => {
  let finish;
  const operation = new Promise((resolve) => { finish = resolve; });
  const run = runInNewContext(extract('assistantWorkerExecution') + '\n' + extract('autoBackgroundExternalTool') + '\nautoBackgroundExternalTool', scope());
  let returned = false;
  const pending = run('search', { autoBackground: true }, operation, { yieldMs: 0 });
  pending.then(() => { returned = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(returned, false);
  finish({ status: 'success', toolReturn: 'finished report' });
  assert.deepEqual(await pending, { status: 'success', toolReturn: 'finished report' });
});

test('worker tool descriptions and schemas agree with synchronous execution and preserve other guidance', () => {
  const schema = { type: 'object', properties: { command: { type: 'string' } } };
  const description = 'Shell safety guidance\n  - Ordinary commands yield\n  - Set background\n  - Pick between Bash and Monitor\nGit safety guidance';
  const tool = { schema: { description, input_schema: schema }, modelForm: { type: 'function' } };
  const registry = new Map([['Bash', tool], ['exec_command', { ...tool, schema: { ...tool.schema, description: 'Yields sessions.\n\nProvide the required description.\nGit safety guidance' } }], ['Monitor', {}], ['Task', {}]]);
  const policy = runInNewContext(extract('applySubagentToolPolicy') + '\napplySubagentToolPolicy', {
    Map, canLaunchSubagentsAtDepth: () => true,
    resolvedModelForm: (_base, description, parameters) => ({ type: 'function', description, parameters }),
  });
  assert.equal(policy(registry, 0), registry);
  const worker = policy(registry, 1);
  assert.equal(worker.has('Monitor'), false);
  assert.equal(worker.has('Task'), true);
  for (const key of ['Bash', 'exec_command']) {
    const patchedTool = worker.get(key);
    assert.match(patchedTool.schema.description, /synchronously|wait for its completed output/);
    assert.match(patchedTool.schema.description, /Git safety guidance/);
    assert.doesNotMatch(patchedTool.schema.description, /Ordinary commands yield|Yields sessions/);
    assert.equal(patchedTool.modelForm.description, patchedTool.schema.description);
  }
  assert.equal(tool.schema.description, description);
  assert.equal(schema.properties.run_in_background, undefined);
});

test('Codex worker execution waits beyond the yield interval and releases the finished session', async () => {
  const session = { id: 'exec_1', status: 'running', output: '', exitCode: null };
  let waited, released = false;
  const exec = runInNewContext(extract('assistantWorkerExecution') + '\n' + extract('exec_command') + '\nexec_command', {
    ...scope(), Infinity,
    validateRequiredParams() {}, startExecSession: async () => session,
    clampYieldTime() { throw new Error('worker must not use yield interval'); },
    waitForSessionOutput: async (args) => {
      waited = args;
      await new Promise((resolve) => setTimeout(resolve, 10));
      session.status = 'completed'; session.exitCode = 0;
      return { output: '202910851145973522', wallTimeMs: 10 };
    },
    generateChunkId: () => 'chunk', estimateTokenCount: () => 1,
    formatExecOutput: ({ output, sessionId }) => { assert.equal(sessionId, null); return output; },
    releaseExecSession: () => { released = true; },
    scrubSecretsFromString: (text) => text,
  });
  assert.equal((await exec({ cmd: 'sleep 20; calculate', yield_time_ms: 1 })).output, '202910851145973522');
  assert.equal(waited.yieldTimeMs, Infinity);
  assert.equal(session.notificationArmed, undefined);
  assert.equal(released, true);
  assert.match(extract('startExecSession'), /timeoutMs: assistantWorkerExecution\(\) \? 120000 : 0/);
});

test('persistent monitors are rejected in workers', async () => {
  const monitor = runInNewContext(extract('assistantWorkerExecution') + '\n' + extract('monitor') + '\nmonitor', scope());
  await assert.rejects(monitor({ command: 'tail -f log' }), /Workers cannot start persistent monitors/);
});

test('patch composes with existing patches and fails closed on changed or already patched bundles', () => {
  assert.doesNotThrow(() => patchBundle(patchTasks(patchModels(original))));
  assert.throws(() => patchBundle(patched), /already patched/);
  assert.throws(() => patchBundle('other release'), /anchor/);
  assert.throws(() => patchBundle(original.replace('async function exec_command(args)', 'async function renamed(args)')
    .replace('const yieldTimeMs = clampYieldTime(args.yield_time_ms, DEFAULT_EXEC_YIELD_TIME_MS);', 'changed')), /anchor/);
});
