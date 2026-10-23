import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_MAX_LIFETIME_MS, MAX_OUTPUT_BYTES, OutputLog } from './process.ts';
import { FilesystemWorkspaceTransport } from './index.ts';

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ws-process-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function replay(log: OutputLog): Promise<{ stream: string; text: string }[]> {
  const out: { stream: string; text: string }[] = [];
  for await (const chunk of log.iterate()) out.push(chunk);
  return out;
}

describe('OutputLog', () => {
  test('the cap is one mebibyte per stream and the default lifetime is 30 minutes', () => {
    assert.equal(MAX_OUTPUT_BYTES, 1024 * 1024);
    assert.equal(DEFAULT_MAX_LIFETIME_MS, 30 * 60 * 1000);
  });

  test('keeps the tail of a stream that exceeds the cap and drops the head', () => {
    const log = new OutputLog(100);
    for (let i = 0; i < 50; i++) log.append({ stream: 'stdout', text: `line-${String(i).padStart(3, '0')}\n` });
    const tail = log.tail('stdout', 1_000);
    assert.match(tail, /^\[output truncated: \d+ bytes omitted\]\n/);
    assert.ok(tail.endsWith('line-049\n'), 'the newest output is kept');
    assert.ok(!tail.includes('line-000'), 'the oldest output is dropped');
    assert.ok(Buffer.byteLength(tail.slice(tail.indexOf('\n') + 1)) <= 100, 'the retained body respects the cap');
  });

  test('a single chunk larger than the cap keeps only its last bytes', () => {
    const log = new OutputLog(16);
    log.append({ stream: 'stderr', text: `${'a'.repeat(100)}END` });
    log.end();
    const tail = log.tail('stderr', 1_000);
    assert.ok(tail.endsWith('END'));
    assert.ok(Buffer.byteLength(tail) <= 16 + 40, 'only the notice and the last bytes remain');
  });

  test('replay keeps stdout and stderr in arrival order and marks dropped output', async () => {
    const log = new OutputLog(10);
    log.append({ stream: 'stdout', text: 'aaaaaaaaaa' });
    log.append({ stream: 'stderr', text: 'err1\n' });
    log.append({ stream: 'stdout', text: 'bbbbbbbbbb' });
    log.append({ stream: 'stdout', text: 'cccccccccc' });
    log.end();
    const chunks = await replay(log);
    const stdout = chunks.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.text);
    assert.match(stdout[0]!, /^\[output truncated: 20 bytes omitted\]/);
    assert.equal(stdout.at(-1), 'cccccccccc');
    assert.deepEqual(
      chunks.filter((chunk) => chunk.stream === 'stderr').map((chunk) => chunk.text),
      ['err1\n'],
      'stderr is capped independently of stdout'
    );
  });

  test('a late reader of a capped log still terminates and sees the newest output', async () => {
    const log = new OutputLog(64);
    for (let i = 0; i < 1_000; i++) log.append({ stream: 'stdout', text: `chunk ${i}\n` });
    log.end();
    const chunks = await replay(log);
    const text = chunks.map((chunk) => chunk.text).join('');
    assert.match(text, /chunk 999\n$/);
    assert.ok(text.length < 1_000, 'replay is bounded by the cap, not by the number of writes');
  });

  test('a live reader keeps following after the log has been trimmed', async () => {
    const log = new OutputLog(20);
    const seen: string[] = [];
    const reading = (async () => {
      for await (const chunk of log.iterate()) seen.push(chunk.text);
    })();
    for (let i = 0; i < 30; i++) {
      log.append({ stream: 'stdout', text: `item-${i}-x\n` });
      await new Promise((resolve) => setImmediate(resolve));
    }
    log.end();
    await reading;
    assert.ok(seen.at(-1)?.startsWith('item-29'), 'the live reader reaches the newest output');
  });

  test('rejects a non-positive cap', () => {
    assert.throws(() => new OutputLog(0), RangeError);
  });
});

describe('command lifetime', () => {
  test('a command that outlives its lifetime is killed and reported as timed out', async () => {
    const transport = new FilesystemWorkspaceTransport({ root, displayRoot: '/workspace', commandLifetimeMs: 300 });
    const started = Date.now();
    const process = await transport.spawn({ command: 'sleep 30' });
    const exit = await process.exited;
    assert.equal(exit.timedOut, true);
    assert.equal(process.running, false);
    assert.ok(Date.now() - started < 15_000, 'killed well before the sleep ends');
  });

  test('a command that finishes within its lifetime is not marked timed out', async () => {
    const transport = new FilesystemWorkspaceTransport({ root, displayRoot: '/workspace', commandLifetimeMs: 60_000 });
    const process = await transport.spawn({ command: 'echo quick' });
    const exit = await process.exited;
    assert.equal(exit.timedOut, false);
    assert.equal(exit.exitCode, 0);
    assert.match(process.tail().stdout, /quick/);
  });
});
