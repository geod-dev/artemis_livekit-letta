import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Logger } from '@artemis/core';
import { FilesystemWorkspaceTransport } from '@artemis/workspace/filesystem';
import type { ToolContext } from '../context.ts';
import { MAX_TOOL_TEXT, type ToolResult } from '../result.ts';
import { Toolset } from '../toolset.ts';
import { createWorkspaceTools, type CommandHandoff } from './index.ts';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let root: string;
let transport: FilesystemWorkspaceTransport;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'tools-ws-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

beforeEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  await mkdir(root, { recursive: true });
  transport = new FilesystemWorkspaceTransport({ root, ripgrep: 'off' });
});

type Adopted = Parameters<CommandHandoff['adopt']>[0];

function harness(handoffDelayMs = 10_000) {
  const adopted: Adopted[] = [];
  const handoff: CommandHandoff = {
    async adopt(input) {
      adopted.push(input);
      return { taskId: `task_${adopted.length}`, outputPath: `data/tasks/task_${adopted.length}.log` };
    },
  };
  const toolset = new Toolset(createWorkspaceTools({ handoff, backgroundAfterMs: handoffDelayMs }));
  const contextFor = (overrides: Partial<ToolContext> = {}): ToolContext =>
    ({
      conversationId: 'conv_1',
      taskId: null,
      turnId: 'turn_1',
      toolCallId: 'toolu_test-1',
      signal: new AbortController().signal,
      policy: 'interactive',
      workspace: transport,
      access: { readOnlyPrefixes: ['data'] },
      logger: silent,
      ...overrides,
    }) as ToolContext;
  return { toolset, adopted, contextFor };
}

function text(result: ToolResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n');
}

describe('file tools', () => {
  test('definitions follow TOOL_NAMES order', () => {
    const { toolset } = harness();
    assert.deepEqual(
      toolset.definitions().map((d) => d.name),
      ['read_file', 'write_file', 'edit_file', 'delete_file', 'list_files', 'search_files', 'bash']
    );
  });

  test('read_file numbers lines and pages with offset and limit', async () => {
    await writeFile(join(root, 'notes.txt'), 'one\ntwo\nthree\nfour\n');
    const { toolset, contextFor } = harness();
    const page = await toolset.execute('read_file', { path: 'notes.txt', offset: 2, limit: 2 }, contextFor());
    assert.equal(page.isError, false);
    assert.match(text(page), /^\s+2\ttwo\n\s+3\tthree/);
    assert.match(text(page), /Lines 2-3 of 4 shown; continue with offset 4/);
    assert.deepEqual(page.display, {
      type: 'file',
      operation: 'read',
      path: 'notes.txt',
      lines: { offset: 2, count: 2, total: 4 },
    });
  });

  test('read_file returns images as image blocks and refuses other binary files', async () => {
    await writeFile(join(root, 'pic.png'), PNG_BYTES);
    await writeFile(join(root, 'blob.bin'), new Uint8Array([1, 0, 2, 0]));
    const { toolset, contextFor } = harness();
    const image = await toolset.execute('read_file', { path: 'pic.png' }, contextFor());
    assert.equal(image.isError, false);
    assert.equal(image.content[1]?.type, 'image');
    const binary = await toolset.execute('read_file', { path: 'blob.bin' }, contextFor());
    assert.equal(binary.isError, true);
    assert.match(text(binary), /binary data and cannot be read as text/);
  });

  test('read_file reports missing paths and directories', async () => {
    await mkdir(join(root, 'dir'));
    const { toolset, contextFor } = harness();
    assert.match(text(await toolset.execute('read_file', { path: 'nope.txt' }, contextFor())), /no such file/);
    assert.match(text(await toolset.execute('read_file', { path: 'dir' }, contextFor())), /is a directory/);
  });

  test('write_file creates files and refuses read-only prefixes', async () => {
    const { toolset, contextFor } = harness();
    const created = await toolset.execute('write_file', { path: 'out/a.txt', content: 'hello' }, contextFor());
    assert.match(text(created), /^Created out\/a\.txt/);
    assert.equal(await readFile(join(root, 'out', 'a.txt'), 'utf8'), 'hello');
    const overwritten = await toolset.execute('write_file', { path: 'out/a.txt', content: 'bye' }, contextFor());
    assert.match(text(overwritten), /^Overwrote/);

    const refused = await toolset.execute('write_file', { path: 'data/x.txt', content: 'no' }, contextFor());
    assert.equal(refused.isError, true);
    assert.match(text(refused), /read-only in this workspace/);
  });

  test('edit_file requires a unique match unless replace_all is set', async () => {
    await writeFile(join(root, 'code.ts'), 'const a = 1;\nconst b = 1;\n');
    const { toolset, contextFor } = harness();
    const ambiguous = await toolset.execute(
      'edit_file',
      { path: 'code.ts', old_string: '= 1', new_string: '= 2' },
      contextFor()
    );
    assert.equal(ambiguous.isError, true);
    assert.match(text(ambiguous), /occurs 2 times/);

    const unique = await toolset.execute(
      'edit_file',
      { path: 'code.ts', old_string: 'const a = 1', new_string: 'const a = $& 2' },
      contextFor()
    );
    assert.equal(unique.isError, false);
    assert.equal(await readFile(join(root, 'code.ts'), 'utf8'), 'const a = $& 2;\nconst b = 1;\n');

    const all = await toolset.execute(
      'edit_file',
      { path: 'code.ts', old_string: '1', new_string: '9', replace_all: true },
      contextFor()
    );
    assert.match(text(all), /replaced 1 occurrence/);
    assert.equal(await readFile(join(root, 'code.ts'), 'utf8'), 'const a = $& 2;\nconst b = 9;\n');
    const missing = await toolset.execute(
      'edit_file',
      { path: 'code.ts', old_string: 'absent', new_string: 'x' },
      contextFor()
    );
    assert.match(text(missing), /was not found/);
  });

  test('delete_file removes files only', async () => {
    await writeFile(join(root, 'gone.txt'), 'x');
    await mkdir(join(root, 'keep'));
    const { toolset, contextFor } = harness();
    assert.equal((await toolset.execute('delete_file', { path: 'gone.txt' }, contextFor())).isError, false);
    assert.equal(await transport.stat('gone.txt'), null);
    const dir = await toolset.execute('delete_file', { path: 'keep' }, contextFor());
    assert.equal(dir.isError, true);
  });

  test('list_files shows directories first and search_files finds matches', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), 'alpha\nneedle here\n');
    await writeFile(join(root, 'README.md'), 'readme\n');
    const { toolset, contextFor } = harness();
    const listing = await toolset.execute('list_files', {}, contextFor());
    assert.match(text(listing), /^src\/\nREADME\.md  \(7 bytes\)$/m);

    const found = await toolset.execute('search_files', { pattern: 'NEEDLE', case_insensitive: true }, contextFor());
    assert.equal(found.isError, false);
    assert.equal(text(found), 'src/a.ts:2: needle here');
    assert.deepEqual(found.display, {
      type: 'file',
      operation: 'search',
      path: '.',
      paths: ['src/a.ts'],
    });

    const none = await toolset.execute('search_files', { pattern: 'zzz' }, contextFor());
    assert.equal(text(none), 'No matches.');
    const invalid = await toolset.execute('search_files', { pattern: '(' }, contextFor());
    assert.equal(invalid.isError, true);
  });
});

describe('bash', () => {
  test('a quick command returns its exit code and output', async () => {
    const { toolset, contextFor } = harness();
    const ok = await toolset.execute('bash', { command: 'echo hi', description: 'say hi' }, contextFor());
    assert.equal(ok.isError, false);
    assert.match(text(ok), /Exit code: 0\.\nstdout:\nhi/);
    assert.equal(ok.display?.type, 'command');

    const failed = await toolset.execute('bash', { command: 'echo bad >&2; exit 4', description: 'fail' }, contextFor());
    assert.equal(failed.isError, true);
    assert.match(text(failed), /Exit code: 4\.\nstderr:\nbad/);
  });

  test('a command still running after backgroundAfterMs is handed off and its output is kept', async () => {
    const { toolset, adopted, contextFor } = harness(200);
    const result = await toolset.execute(
      'bash',
      { command: 'sleep 1; echo finished', description: 'slow job' },
      contextFor()
    );
    assert.equal(result.isError, false);
    assert.equal(result.backgrounded, true);
    assert.deepEqual(result.task, { taskId: 'task_1', kind: 'command', relation: 'backgrounded', title: 'slow job' });
    assert.match(text(result), /still running in the background as task task_1 \(log: data\/tasks\/task_1\.log\)/);
    assert.match(text(result), /do not poll/);
    assert.equal(adopted.length, 1);
    assert.equal(adopted[0]?.reason, 'handoff');
    assert.equal(adopted[0]?.description, 'slow job');

    const process = adopted[0]!.process;
    assert.equal((await process.exited).exitCode, 0);
    const replayed = [];
    for await (const chunk of process.output()) replayed.push(chunk.text);
    assert.match(replayed.join(''), /finished/, 'output written before adoption is replayed');
  });

  test('a command that finishes within the delay is not handed off', async () => {
    const { toolset, adopted, contextFor } = harness(5_000);
    const result = await toolset.execute('bash', { command: 'echo quick', description: 'quick' }, contextFor());
    assert.equal(result.backgrounded, undefined);
    assert.equal(adopted.length, 0);
    assert.match(text(result), /quick/);
  });

  test('run_in_background adopts at once with reason requested', async () => {
    const { toolset, adopted, contextFor } = harness();
    const result = await toolset.execute(
      'bash',
      { command: 'sleep 2', description: 'long', run_in_background: true },
      contextFor()
    );
    assert.equal(result.isError, false);
    assert.equal(result.task?.relation, 'started');
    assert.deepEqual(result.display?.type === 'command' ? result.display.background : undefined, {
      taskId: 'task_1',
      reason: 'requested',
    });
    assert.equal(adopted[0]?.reason, 'requested');
    await adopted[0]!.process.kill();
  });

  test('an abort during a foreground command kills it and reports the interruption', async () => {
    const controller = new AbortController();
    const { toolset, adopted, contextFor } = harness(10_000);
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await toolset.execute(
      'bash',
      { command: 'sleep 30', description: 'stuck' },
      contextFor({ signal: controller.signal })
    );
    assert.ok(Date.now() - started < 15_000);
    assert.equal(result.isError, true);
    assert.match(text(result), /Interrupted by user/);
    assert.equal(adopted.length, 0);
  });

  test('synchronous runs are bounded by timeout_ms and never hand off', async () => {
    const { toolset, adopted, contextFor } = harness(50);
    const started = Date.now();
    const result = await toolset.execute(
      'bash',
      { command: 'sleep 30', description: 'hang', timeout_ms: 1_000 },
      contextFor({ policy: 'synchronous' })
    );
    assert.ok(Date.now() - started < 15_000);
    assert.equal(result.isError, true);
    assert.equal(result.display?.type === 'command' ? result.display.timedOut : undefined, true);
    assert.equal(adopted.length, 0);
  });

  test('synchronous runs refuse run_in_background', async () => {
    const { toolset, contextFor } = harness();
    const result = await toolset.execute(
      'bash',
      { command: 'echo x', description: 'x', run_in_background: true },
      contextFor({ policy: 'synchronous' })
    );
    assert.equal(result.isError, true);
    assert.match(text(result), /not available inside a subagent/);
  });

  test('long output is cut for the model and the full log is written under data/', async () => {
    const { toolset, contextFor } = harness();
    const result = await toolset.execute(
      'bash',
      { command: `head -c ${MAX_TOOL_TEXT + 5000} /dev/zero | tr '\\0' 'a'`, description: 'big' },
      contextFor()
    );
    assert.equal(result.isError, false);
    assert.equal(result.display?.type === 'command' ? result.display.truncated : undefined, true);
    assert.ok(text(result).length < MAX_TOOL_TEXT);
    assert.match(text(result), /full output: data\/command-logs\/toolu_test-1\.log/);
    const log = await readFile(join(root, 'data', 'command-logs', 'toolu_test-1.log'), 'utf8');
    assert.ok(log.length > MAX_TOOL_TEXT);
  });
});
