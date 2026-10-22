import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { prefixedId } from '@artemis/core';
import { type ProcessExit, type ProcessOutputChunk, WorkspaceProcess } from '../transport.ts';

const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;
/** After the shell exits, output may still flow from its children for this long. */
const STDIO_DRAIN_MS = 250;

export interface StartProcessOptions {
  command: string;
  /** Shell binary, run as `shell -lc <command>`. */
  shell: string;
  /** Absolute host directory. */
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  runAs?: { uid: number; gid: number };
}

/**
 * Spawns `command` in its own process group (POSIX) or process tree (Windows).
 * Resolves once the shell has started; rejects when it cannot be started.
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
  const handle = new FilesystemProcess(child, options.command);
  if (options.timeoutMs !== undefined) handle.armTimeout(options.timeoutMs);
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

  private readonly log = new OutputLog();
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  private resolveExit!: (exit: ProcessExit) => void;
  private finished = false;
  private timedOut = false;
  private shellExit: { exitCode: number | null; signal: string | null } | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private drain: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly child: ChildProcess,
    readonly command: string
  ) {
    super();
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

  /** Kill the process tree after `ms` (used by synchronous runs). */
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

/** Append-only chunk log with replay for any number of concurrent readers. */
class OutputLog {
  private readonly chunks: ProcessOutputChunk[] = [];
  private ended = false;
  private readonly waiters = new Set<() => void>();

  append(chunk: ProcessOutputChunk): void {
    this.chunks.push(chunk);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  async *iterate(): AsyncIterable<ProcessOutputChunk> {
    let next = 0;
    for (;;) {
      while (next < this.chunks.length) yield this.chunks[next++]!;
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  /** The last `maxBytes` bytes of one stream (a multi-byte character cut at the start may decode as U+FFFD). */
  tail(stream: 'stdout' | 'stderr', maxBytes: number): string {
    const pieces: string[] = [];
    let bytes = 0;
    for (let i = this.chunks.length - 1; i >= 0 && bytes < maxBytes; i--) {
      const chunk = this.chunks[i]!;
      if (chunk.stream !== stream) continue;
      pieces.unshift(chunk.text);
      bytes += Buffer.byteLength(chunk.text);
    }
    const text = pieces.join('');
    const buffer = Buffer.from(text);
    return buffer.length > maxBytes ? buffer.subarray(buffer.length - maxBytes).toString('utf8') : text;
  }

  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }
}
