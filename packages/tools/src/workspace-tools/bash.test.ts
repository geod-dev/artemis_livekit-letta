import type { WorkspaceProcess } from '@artemis/workspace';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeWorkspace, ScriptedProcess, testContext } from '../test-support/fake-workspace.ts';
import { BashTool } from './bash.ts';
import type { CommandHandoff } from './types.ts';

function handoffRecorder(): CommandHandoff & { adopted: string[] } {
  const adopted: string[] = [];
  return {
    adopted,
    async adopt(input) {
      adopted.push(input.command);
      return { taskId: 'task_1', outputPath: 'data/command-logs/task_1.log' };
    },
  };
}

test('a synchronous command reports its exit code and stdout', async () => {
  const workspace = new FakeWorkspace(
    () =>
      new ScriptedProcess('echo hi', [{ stream: 'stdout', text: 'hi\n' }], {
        exitCode: 0,
        signal: null,
        timedOut: false,
      })
  );
  const tool = new BashTool({ handoff: handoffRecorder(), backgroundAfterMs: 10_000 });

  const result = await tool.execute(
    { command: 'echo hi', description: 'say hi' },
    testContext(workspace, 'synchronous')
  );

  assert.equal(result.isError, false);
  assert.equal(
    result.content[0]?.type === 'text' && result.content[0].text,
    'Exit code: 0.\nstdout:\nhi'
  );
  assert.equal(workspace.spawned[0]?.timeoutMs, 120_000);
});

test('a failing command is an error result with its stderr', async () => {
  const workspace = new FakeWorkspace(
    () =>
      new ScriptedProcess('false', [{ stream: 'stderr', text: 'boom\n' }], {
        exitCode: 2,
        signal: null,
        timedOut: false,
      })
  );
  const tool = new BashTool({ handoff: handoffRecorder(), backgroundAfterMs: 10_000 });

  const result = await tool.execute(
    { command: 'false', description: 'fail' },
    testContext(workspace, 'synchronous')
  );

  assert.equal(result.isError, true);
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  assert.match(text, /Exit code: 2\./);
  assert.match(text, /stderr:\nboom/);
});

test('a synchronous command killed by its timeout says so', async () => {
  const workspace = new FakeWorkspace(
    () => new ScriptedProcess('sleep 9', [], { exitCode: null, signal: 'SIGTERM', timedOut: true })
  );
  const tool = new BashTool({ handoff: handoffRecorder(), backgroundAfterMs: 10_000 });

  const result = await tool.execute(
    { command: 'sleep 9', description: 'sleep', timeout_ms: 5_000 },
    testContext(workspace, 'synchronous')
  );

  assert.equal(result.isError, true);
  assert.equal(workspace.spawned[0]?.timeoutMs, 5_000);
  assert.match(
    result.content[0]?.type === 'text' ? result.content[0].text : '',
    /Timed out and was killed \(timeout_ms 5000\)/
  );
});

test('a subagent cannot start a command in the background', async () => {
  const workspace = new FakeWorkspace();
  const tool = new BashTool({ handoff: handoffRecorder(), backgroundAfterMs: 10_000 });

  const result = await tool.execute(
    { command: 'sleep 1', description: 'sleep', run_in_background: true },
    testContext(workspace, 'synchronous')
  );

  assert.equal(result.isError, true);
  assert.equal(workspace.spawned.length, 0);
});

test('a command still running after the delay moves to the background on the same process', async () => {
  const handoff = handoffRecorder();
  let started: WorkspaceProcess | undefined;
  const workspace = new FakeWorkspace(
    (options) => (started = new ScriptedProcess(options.command))
  );
  const tool = new BashTool({ handoff, backgroundAfterMs: 5 });

  const result = await tool.execute(
    { command: 'server', description: 'serve' },
    testContext(workspace, 'interactive')
  );

  assert.equal(result.isError, false);
  assert.equal(result.backgrounded, true);
  assert.deepEqual(handoff.adopted, ['server']);
  assert.equal(result.task?.taskId, 'task_1');
  assert.equal(started?.running, true);
});
