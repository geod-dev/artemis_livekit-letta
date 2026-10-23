import { type Logger } from '@artemis/core';
import {
  type FileStat,
  type ProcessExit,
  type ProcessOutputChunk,
  type SpawnOptions,
  type WorkspaceAccessPolicy,
  WorkspacePathError,
  WorkspaceProcess,
  WorkspaceTransport,
  type WriteHandle,
} from '@artemis/workspace';
import type { ToolContext } from '../context.ts';

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/$/, '');
}

/** A command whose output and exit are scripted by the test. `exit: null` keeps it running until `kill`. */
export class ScriptedProcess extends WorkspaceProcess {
  readonly id = 'proc_test';
  readonly startedAt = new Date(0).toISOString();
  readonly exited: Promise<ProcessExit>;
  private finished = false;
  private resolveExit!: (exit: ProcessExit) => void;

  constructor(
    readonly command: string,
    private readonly chunks: ProcessOutputChunk[] = [],
    exit: ProcessExit | null = null
  ) {
    super();
    this.exited = new Promise<ProcessExit>((resolve) => (this.resolveExit = resolve));
    if (exit) this.finish(exit);
  }

  get running(): boolean {
    return !this.finished;
  }

  async *output(): AsyncIterable<ProcessOutputChunk> {
    yield* this.chunks;
  }

  tail(): { stdout: string; stderr: string } {
    const text = (stream: 'stdout' | 'stderr') =>
      this.chunks
        .filter((chunk) => chunk.stream === stream)
        .map((chunk) => chunk.text)
        .join('');
    return { stdout: text('stdout'), stderr: text('stderr') };
  }

  async kill(): Promise<ProcessExit> {
    this.finish({ exitCode: null, signal: 'SIGTERM', timedOut: false });
    return this.exited;
  }

  async writeStdin(): Promise<void> {
    throw new Error('ScriptedProcess does not accept input');
  }

  private finish(exit: ProcessExit): void {
    this.finished = true;
    this.resolveExit(exit);
  }
}

/** In-memory workspace: files by workspace-relative path. `spawn` records its options and returns `processFor(options)`. */
export class FakeWorkspace extends WorkspaceTransport {
  readonly displayRoot = '/workspace';
  readonly files = new Map<string, Uint8Array>();
  readonly spawned: SpawnOptions[] = [];

  constructor(
    private readonly processFor: (options: SpawnOptions) => WorkspaceProcess = (options) =>
      new ScriptedProcess(options.command, [], { exitCode: 0, signal: null, timedOut: false }),
    private readonly readOnlyPrefixes: string[] = []
  ) {
    super();
  }

  addText(path: string, text: string): void {
    this.files.set(normalize(path), new TextEncoder().encode(text));
  }

  async stat(path: string): Promise<FileStat | null> {
    const key = normalize(path);
    const bytes = this.files.get(key);
    if (!bytes) return null;
    return {
      path: key,
      type: 'file',
      size: bytes.byteLength,
      modifiedAt: new Date(0).toISOString(),
    };
  }

  async realPath(path: string): Promise<string> {
    return normalize(path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(normalize(path));
    if (!bytes) throw new Error(`${path}: no such file`);
    return bytes;
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    this.files.set(
      normalize(path),
      typeof data === 'string' ? new TextEncoder().encode(data) : data
    );
  }

  async openWrite(path: string): Promise<WriteHandle> {
    const chunks: Uint8Array[] = [];
    return {
      write: async (chunk) => {
        chunks.push(chunk);
      },
      commit: async (finalPath) => {
        const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const joined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.files.set(normalize(finalPath), joined);
      },
      abort: async () => {
        chunks.length = 0;
      },
    };
  }

  async readStream(): Promise<ReadableStream<Uint8Array>> {
    throw new Error('FakeWorkspace does not stream');
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(normalize(path));
  }

  async makeDirectory(): Promise<void> {}

  async removeEmptyDirectory(): Promise<void> {}

  async list(path: string): Promise<FileStat[]> {
    const dir = normalize(path);
    const entries: FileStat[] = [];
    for (const key of this.files.keys()) {
      const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '.';
      if (parent === dir || (dir === '.' && parent === '.')) {
        entries.push((await this.stat(key))!);
      }
    }
    return entries;
  }

  async glob(): Promise<string[]> {
    throw new Error('FakeWorkspace does not glob');
  }

  async grep(): Promise<never[]> {
    throw new Error('FakeWorkspace does not grep');
  }

  async spawn(options: SpawnOptions): Promise<WorkspaceProcess> {
    this.spawned.push(options);
    return this.processFor(options);
  }

  assertWritable(path: string, policy: WorkspaceAccessPolicy): void {
    const key = normalize(path);
    for (const prefix of [...policy.readOnlyPrefixes, ...this.readOnlyPrefixes]) {
      const readOnly = normalize(prefix);
      if (key === readOnly || key.startsWith(`${readOnly}/`)) {
        throw new WorkspacePathError(path, 'read-only in this workspace');
      }
    }
  }
}

/** A tool context over `workspace`; writes under `data/` are read-only, as in the agent server. */
export function testContext(
  workspace: WorkspaceTransport,
  policy: ToolContext['policy'] = 'interactive'
): ToolContext {
  return {
    conversationId: 'conv_test',
    taskId: null,
    turnId: null,
    toolCallId: 'call_test',
    signal: new AbortController().signal,
    policy,
    workspace,
    access: { readOnlyPrefixes: ['data/'] },
    logger: silent,
  };
}
