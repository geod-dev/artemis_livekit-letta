import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { prefixedId } from '@artemis/core';
import { type ProcessExit, type ProcessOutputChunk, WorkspaceProcess } from '../transport.ts';

const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;
/** After the shell exits, output may still flow from its children for this long. */
const STDIO_DRAIN_MS = 250;
/** Retained output per stream (stdout, stderr). The oldest output is dropped and the tail kept. */
export const MAX_OUTPUT_BYTES = 1024 * 1024;
/** Wall-clock lifetime of a command that has no `timeoutMs` (background and interactive commands). */
export const DEFAULT_MAX_LIFETIME_MS = 30 * 60 * 1000;

const STREAMS = ['stdout', 'stderr'] as const;

export interface StartProcessOptions {
  command: string;
  /** Shell binary, run as `shell -lc <command>`. */
  shell: string;
  /** Absolute host directory. */
  cwd: string;
  env: Record<string, string>;
  /** Synchronous runs: kill after this long. Takes precedence over `maxLifetimeMs`. */
  timeoutMs?: number;
  /** Kill after this long when no `timeoutMs` is given. Default `DEFAULT_MAX_LIFETIME_MS`. */
  maxLifetimeMs?: number;
  /** Retained output per stream. Default `MAX_OUTPUT_BYTES`. */
  maxOutputBytes?: number;
  runAs?: { uid: number; gid: number };
}

/**
 * Spawns `command` in its own process group (POSIX) or process tree (Windows).
 * Resolves once the shell has started; rejects when it cannot be started.
 * Every process is killed once its lifetime (`timeoutMs`, else `maxLifetimeMs`) elapses.
 */
export async function startProcess(options: StartProcessOptions): Promise<FilesystemProcess> {
  const child = spawn(options.shell, ['-lc', options.command], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(process.platform !== 'win32' && options.runAs ? { uid: options.runAs.uid, gid: options.runAs.gid } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const handle = new FilesystemProcess(child, options.command, options.maxOutputBytes);
  handle.armTimeout(options.timeoutMs ?? options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS);
  return handle;
}

/**
 * Signals the whole tree of `child`: the process group on POSIX, `taskkill /T`
 * on Windows (which has no graceful group signal, so it always forces). Resolves
 * once the tree has been signalled (on Windows: once `taskkill` has finished).
 */
export function signalTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve()));
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
  return Promise.resolve();
}

/** A command running in the workspace. Output is buffered from spawn, so a later owner can replay it. */
export class FilesystemProcess extends WorkspaceProcess {
  readonly id = prefixedId('proc');
  readonly startedAt = new Date().toISOString();
  readonly exited: Promise<ProcessExit>;

  private readonly log: OutputLog;
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  private resolveExit!: (exit: ProcessExit) => void;
  private finished = false;
  private timedOut = false;
  private shellExit: { exitCode: number | null; signal: string | null } | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private drain: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly child: ChildProcess,
    readonly command: string,
    maxOutputBytes = MAX_OUTPUT_BYTES
  ) {
    super();
    this.log = new OutputLog(maxOutputBytes);
    this.exited = new Promise<ProcessExit>((resolve) => (this.resolveExit = resolve));
    child.stdout?.on('data', (data: Buffer) => this.append('stdout', this.decoders.stdout.write(data)));
    child.stderr?.on('data', (data: Buffer) => this.append('stderr', this.decoders.stderr.write(data)));
    child.on('exit', (exitCode, signal) => {
      this.shellExit ??= { exitCode, signal };
      // Background children may keep the pipes open; do not wait for them.
      this.drain ??= setTimeout(() => this.finish(), STDIO_DRAIN_MS);
    });
    child.on('close', (exitCode, signal) => {
      this.shellExit ??= { exitCode, signal };
      this.finish();
    });
    // Errors after a successful spawn (e.g. a failed kill) do not end the process; keep the listener so they are not fatal.
    child.on('error', () => {});
  }

  get running(): boolean {
    return !this.finished;
  }

  output(): AsyncIterable<ProcessOutputChunk> {
    return this.log.iterate();
  }

  tail(maxBytes = DEFAULT_TAIL_BYTES): { stdout: string; stderr: string } {
    return { stdout: this.log.tail('stdout', maxBytes), stderr: this.log.tail('stderr', maxBytes) };
  }

  /** Resolves once the shell has exited and its tree has been signalled, so no child keeps the directory busy. */
  async kill(graceMs = DEFAULT_KILL_GRACE_MS): Promise<ProcessExit> {
    if (this.finished) return this.exited;
    const signalled = signalTree(this.child, 'SIGTERM');
    const force = setTimeout(() => {
      if (!this.finished) void signalTree(this.child, 'SIGKILL');
    }, graceMs);
    const exit = await this.exited.finally(() => clearTimeout(force));
    await signalled;
    return exit;
  }

  async writeStdin(text: string): Promise<void> {
    const stdin = this.child.stdin;
    if (this.finished || !stdin || !stdin.writable) throw new Error(`${this.id} is not accepting input`);
    await new Promise<void>((resolve, reject) => stdin.write(text, (error) => (error ? reject(error) : resolve())));
  }

  /** Kill the process tree after `ms` (lifetime limit, or the synchronous timeout). */
  armTimeout(ms: number): void {
    this.timeout = setTimeout(() => {
      this.timedOut = true;
      void this.kill();
    }, ms);
  }

  private append(stream: 'stdout' | 'stderr', text: string): void {
    if (text && !this.finished) this.log.append({ stream, text });
  }

  private finish(): void {
    if (this.finished) return;
    this.append('stdout', this.decoders.stdout.end());
    this.append('stderr', this.decoders.stderr.end());
    this.finished = true;
    if (this.timeout) clearTimeout(this.timeout);
    if (this.drain) clearTimeout(this.drain);
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.log.end();
    this.resolveExit({
      exitCode: this.shellExit?.exitCode ?? null,
      signal: this.shellExit?.signal ?? null,
      timedOut: this.timedOut,
    });
  }
}

/** The notice that replaces dropped output, in the stream it was dropped from. */
export function truncationNotice(droppedBytes: number): string {
  return `[output truncated: ${droppedBytes} bytes omitted]\n`;
}

interface Entry {
  /** Global arrival order across both streams. */
  seq: number;
  text: string;
  bytes: number;
}

/**
 * Chunks of one stream with a byte cap. Entries are addressed by an absolute
 * index that never changes, so readers keep their place after old entries are dropped.
 */
class StreamBuffer {
  private readonly entries: Entry[] = [];
  /** Index into `entries` of the first retained entry. */
  private head = 0;
  /** Absolute index of `entries[0]` (grows when consumed entries are compacted away). */
  private offset = 0;
  private retainedBytes = 0;
  /** Bytes dropped from the front so far. */
  dropped = 0;

  /** Absolute index of the first retained entry. */
  get first(): number {
    return this.offset + this.head;
  }

  at(index: number): Entry | undefined {
    const i = index - this.offset;
    return i >= this.head && i < this.entries.length ? this.entries[i] : undefined;
  }

  push(seq: number, text: string, maxBytes: number): void {
    const bytes = Buffer.byteLength(text);
    this.entries.push({ seq, text, bytes });
    this.retainedBytes += bytes;
    // Drop the oldest entries, but always keep the newest one.
    while (this.retainedBytes > maxBytes && this.entries.length - this.head > 1) {
      const old = this.entries[this.head++]!;
      this.retainedBytes -= old.bytes;
      this.dropped += old.bytes;
    }
    // A single entry larger than the cap keeps only its last `maxBytes` bytes.
    if (this.retainedBytes > maxBytes) {
      const last = this.entries[this.entries.length - 1]!;
      const buffer = Buffer.from(last.text);
      const kept = buffer.subarray(buffer.length - maxBytes);
      this.dropped += buffer.length - kept.length;
      last.text = kept.toString('utf8');
      last.bytes = kept.length;
      this.retainedBytes = kept.length;
    }
    if (this.head > 1024 && this.head * 2 > this.entries.length) {
      this.entries.splice(0, this.head);
      this.offset += this.head;
      this.head = 0;
    }
  }

  /** The last `maxBytes` retained bytes, with a truncation notice first when output was dropped. */
  tail(maxBytes: number): string {
    const pieces: string[] = [];
    let bytes = 0;
    for (let i = this.entries.length - 1; i >= this.head && bytes < maxBytes; i--) {
      const entry = this.entries[i]!;
      pieces.unshift(entry.text);
      bytes += entry.bytes;
    }
    const text = pieces.join('');
    const buffer = Buffer.from(text);
    const body = buffer.length > maxBytes ? buffer.subarray(buffer.length - maxBytes).toString('utf8') : text;
    return this.dropped > 0 ? truncationNotice(this.dropped) + body : body;
  }
}

/**
 * Append-only output per stream, each capped at `maxBytes`: the head is dropped
 * and the tail kept. Replay works for any number of concurrent readers; a reader
 * that missed dropped output first receives a truncation notice.
 */
export class OutputLog {
  private readonly streams: Record<'stdout' | 'stderr', StreamBuffer> = {
    stdout: new StreamBuffer(),
    stderr: new StreamBuffer(),
  };
  private seq = 0;
  private ended = false;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly maxBytes = MAX_OUTPUT_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer');
  }

  append(chunk: ProcessOutputChunk): void {
    if (!chunk.text) return;
    this.streams[chunk.stream].push(this.seq++, chunk.text, this.maxBytes);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  async *iterate(): AsyncIterable<ProcessOutputChunk> {
    const cursor = { stdout: 0, stderr: 0 };
    for (;;) {
      for (const name of STREAMS) {
        const buffer = this.streams[name];
        if (cursor[name] < buffer.first) {
          cursor[name] = buffer.first;
          yield { stream: name, text: truncationNotice(buffer.dropped) };
        }
      }
      let next: (typeof STREAMS)[number] | null = null;
      for (const name of STREAMS) {
        const entry = this.streams[name].at(cursor[name]);
        if (!entry) continue;
        const current = next === null ? undefined : this.streams[next].at(cursor[next]);
        if (next === null || !current || entry.seq < current.seq) next = name;
      }
      if (next !== null) {
        const entry = this.streams[next].at(cursor[next])!;
        cursor[next]++;
        yield { stream: next, text: entry.text };
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  /** The last `maxBytes` bytes of one stream (a multi-byte character cut at the start may decode as U+FFFD). */
  tail(stream: 'stdout' | 'stderr', maxBytes: number): string {
    return this.streams[stream].tail(maxBytes);
  }

  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }
}
