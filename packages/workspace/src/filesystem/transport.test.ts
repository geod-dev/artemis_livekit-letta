import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { WorkspacePathError } from '../transport.ts';
import { FilesystemWorkspaceTransport } from './index.ts';

let root: string;
let outside: string;
let fileLinksAllowed = false;
let dirLinksAllowed = false;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ws-root-'));
  outside = await mkdtemp(join(tmpdir(), 'ws-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'top secret\n');
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const needle = 1;\nconst other = 2;\n');
  await writeFile(join(root, 'src', 'deep', 'b.ts'), 'const NEEDLE = 3;\n');
  await writeFile(join(root, 'notes.md'), 'needle in notes\n');
  await writeFile(join(root, 'node_modules', 'pkg', 'c.ts'), 'needle in deps\n');
  await writeFile(join(root, '.git', 'config.ts'), 'needle in git\n');
  await writeFile(join(root, 'image.bin'), Buffer.from([0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  // Windows without symlink privilege cannot create file symlinks (directory junctions still work): such tests are skipped.
  try {
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'), 'file');
    await symlink(join(root, 'notes.md'), join(root, 'notes-link.md'), 'file');
    fileLinksAllowed = true;
  } catch {
    fileLinksAllowed = false;
  }
  try {
    await symlink(outside, join(root, 'escape-dir'), 'junction');
    dirLinksAllowed = true;
  } catch {
    dirLinksAllowed = false;
  }
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  await rm(outside, { recursive: true, force: true });
});

const transport = (ripgrep: 'auto' | 'off' = 'off', extra: { shell?: string; env?: Record<string, string> } = {}) =>
  new FilesystemWorkspaceTransport({ root, displayRoot: '/workspace', ripgrep, ...extra });

describe('files', () => {
  test('writes are atomic, create parents and leave no temporary file', async () => {
    const t = transport();
    await t.writeFile('made/deeper/out.txt', 'hello\n');
    assert.equal(await readFile(join(root, 'made', 'deeper', 'out.txt'), 'utf8'), 'hello\n');
    assert.deepEqual(
      (await readdir(join(root, 'made', 'deeper'))).filter((name) => name.endsWith('.tmp')),
      []
    );
    await t.writeFile('made/deeper/out.txt', new TextEncoder().encode('replaced'));
    assert.equal(await t.readText('/workspace/made/deeper/out.txt'), 'replaced');
  });

  test('readText slices by zero-based line offset and limit', async () => {
    await writeFile(join(root, 'lines.txt'), 'a\nb\nc\nd\n');
    const t = transport();
    assert.equal(await t.readText('lines.txt', { offset: 1, limit: 2 }), 'b\nc');
    assert.equal(await t.readText('lines.txt'), 'a\nb\nc\nd\n');
  });

  test('stat, list and delete report entries and refuse directories', async () => {
    const t = transport();
    assert.equal((await t.stat('src'))?.type, 'directory');
    assert.equal(await t.stat('missing.txt'), null);
    const names = (await t.list('src')).map((entry) => entry.path);
    assert.deepEqual(names, ['src/a.ts', 'src/deep']);
    await t.writeFile('to-delete.txt', 'x');
    await t.deleteFile('to-delete.txt');
    assert.equal(await t.stat('to-delete.txt'), null);
    await assert.rejects(() => t.deleteFile('src'), /is a directory/);
  });

  test('paths outside the root are rejected', async () => {
    const t = transport();
    await assert.rejects(() => t.readFile('../outside'), WorkspacePathError);
    await assert.rejects(() => t.writeFile('/etc/hosts', 'x'), WorkspacePathError);
  });

  test('file symlinks that resolve outside the root are refused for reads and writes', async (ctx) => {
    if (!fileLinksAllowed) return ctx.skip('file symlinks need privileges on this platform');
    const t = transport();
    await assert.rejects(() => t.readFile('escape.txt'), WorkspacePathError);
    await assert.rejects(() => t.writeFile('escape.txt', 'overwrite'), WorkspacePathError);
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'top secret\n');
  });

  test('directory links that resolve outside the root are refused', async (ctx) => {
    if (!dirLinksAllowed) return ctx.skip('directory links unavailable');
    const t = transport();
    await assert.rejects(() => t.writeFile('escape-dir/new.txt', 'x'), WorkspacePathError);
    await assert.rejects(() => t.list('escape-dir'), WorkspacePathError);
    await assert.rejects(() => t.readFile('escape-dir/secret.txt'), WorkspacePathError);
    assert.equal(await t.stat('escape-dir').then((info) => info?.type), 'symlink');
  });

  test('a symlink inside the root can be read', async (ctx) => {
    if (!fileLinksAllowed) return ctx.skip('file symlinks need privileges on this platform');
    assert.equal(await transport().readText('notes-link.md'), 'needle in notes\n');
  });

  test('assertWritable refuses read-only prefixes', () => {
    const t = transport();
    const policy = { readOnlyPrefixes: ['data'] };
    t.assertWritable('src/a.ts', policy);
    t.assertWritable('database.txt', policy);
    assert.throws(() => t.assertWritable('data/attachments/x.png', policy), WorkspacePathError);
    assert.throws(() => t.assertWritable('/workspace/data', policy), WorkspacePathError);
  });
});

describe('search', () => {
  test('glob returns workspace-relative files and skips default ignores', async () => {
    const found = await transport().glob('**/*.ts');
    assert.deepEqual(found.filter((path) => path.startsWith('src/')), ['src/a.ts', 'src/deep/b.ts']);
    assert.ok(!found.some((path) => path.includes('node_modules') || path.includes('.git/')));
  });

  for (const ripgrep of ['off', 'auto'] as const) {
    test(`grep finds matches (ripgrep: ${ripgrep})`, async () => {
      const matches = await transport(ripgrep).grep('needle', { include: '*.ts', caseInsensitive: false });
      assert.deepEqual(
        matches.map((m) => `${m.path}:${m.line}`).sort(),
        ['src/a.ts:1'],
        'case-sensitive match only in src/a.ts; node_modules and .git are skipped'
      );
      const insensitive = await transport(ripgrep).grep('needle', { include: '*.ts', caseInsensitive: true });
      assert.deepEqual(insensitive.map((m) => `${m.path}:${m.line}`).sort(), ['src/a.ts:1', 'src/deep/b.ts:1']);
    });
  }

  test('grep skips binary files and honours the limit', async () => {
    const all = await transport().grep('needle', { caseInsensitive: true, limit: 2 });
    assert.equal(all.length, 2);
    assert.ok(!all.some((m) => m.path === 'image.bin'));
  });

  for (const ripgrep of ['off', 'auto'] as const) {
    test(`grep rejects an invalid pattern (ripgrep: ${ripgrep})`, async () => {
      await assert.rejects(() => transport(ripgrep).grep('(unclosed'));
    });
  }
});

describe('processes', () => {
  test('spawn runs under the shell and buffers output for replay', async () => {
    const process = await transport().spawn({ command: 'echo hello; echo oops >&2; exit 3' });
    const exit = await process.exited;
    assert.equal(exit.exitCode, 3);
    assert.equal(exit.timedOut, false);
    assert.equal(process.running, false);
    const chunks: string[] = [];
    for await (const chunk of process.output()) chunks.push(`${chunk.stream}:${chunk.text.trim()}`);
    assert.deepEqual(chunks, ['stdout:hello', 'stderr:oops']);
    assert.equal(process.tail().stdout.trim(), 'hello');
  });

  test('spawn does not pass server secrets to commands', async () => {
    process.env.ARTEMIS_TEST_SECRET = 'leak-me';
    try {
      const probe = await transport().spawn({ command: 'echo "[${ARTEMIS_TEST_SECRET:-absent}]"' });
      await probe.exited;
      const output = probe.tail().stdout;
      assert.match(output, /\[absent\]/);
    } finally {
      delete process.env.ARTEMIS_TEST_SECRET;
    }
  });

  test('spawn honours the working directory inside the root only', async () => {
    const pwd = await transport().spawn({ command: 'pwd', cwd: 'src' });
    await pwd.exited;
    assert.match(pwd.tail().stdout.trim(), /src$/);
    await assert.rejects(() => transport().spawn({ command: 'pwd', cwd: '..' }), WorkspacePathError);
  });

  test('timeoutMs kills the process tree and reports timedOut', async () => {
    const started = Date.now();
    const process = await transport().spawn({ command: 'sleep 30', timeoutMs: 300 });
    const exit = await process.exited;
    assert.equal(exit.timedOut, true);
    assert.ok(Date.now() - started < 15_000, 'killed well before the sleep ends');
  });

  test('kill terminates a running command', async () => {
    const process = await transport().spawn({ command: 'sleep 30' });
    assert.equal(process.running, true);
    const exit = await process.kill(500);
    assert.equal(process.running, false);
    assert.equal(exit.timedOut, false);
    assert.ok(exit.exitCode !== 0 || exit.signal !== null);
  });

  test('writeStdin reaches the command', async () => {
    const process = await transport().spawn({ command: 'read line; echo "got $line"' });
    await process.writeStdin('ping\n');
    const exit = await process.exited;
    assert.equal(exit.exitCode, 0);
    assert.match(process.tail().stdout, /got ping/);
  });

  test('a late reader replays everything written before it started', async () => {
    const process = await transport().spawn({ command: 'echo one; echo two' });
    await process.exited;
    const replayed: string[] = [];
    for await (const chunk of process.output()) replayed.push(chunk.text);
    assert.match(replayed.join(''), /one\s+two/);
  });
});
