/**
 * The agent's workspace: the ONLY way any code touches workspace files or runs
 * commands for the agent. Paths are workspace-relative POSIX paths
 * (`files/report.xlsx`); implementations reject anything resolving outside the
 * root (realpath containment, symlinks included).
 *
 * The filesystem vendor's `FilesystemWorkspaceTransport` serves a local
 * directory and spawns local processes; a future remote transport (SSH,
 * sandbox API, ...) implements the same two halves: files and processes.
 */

export interface FileStat {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
}

/** An inclusive byte range, as in an HTTP `Range` header. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface GlobOptions {
  /** Directory to search from (workspace-relative, default root). */
  cwd?: string;
  /** Patterns to skip (default: `.git/**`, `node_modules/**`). */
  ignore?: string[];
  limit?: number;
}

export interface GrepOptions {
  path?: string;
  /** Glob filter, e.g. `*.ts`. */
  include?: string;
  caseInsensitive?: boolean;
  contextLines?: number;
  limit?: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** Write policy: which workspace areas the agent may change (e.g. not `data/`). */
export interface WorkspaceAccessPolicy {
  /** Workspace-relative prefixes that agent tools may read but never write/delete. */
  readOnlyPrefixes: string[];
}

export interface SpawnOptions {
  /** Shell command line, run with `bash -lc` (POSIX shell). */
  command: string;
  /** Workspace-relative working directory (default root). */
  cwd?: string;
  env?: Record<string, string>;
  /** Kill the process tree after this long (no default: callers decide). */
  timeoutMs?: number;
}

export interface ProcessExit {
  exitCode: number | null;
  signal: string | null;
  /** Killed by `timeoutMs`. */
  timedOut: boolean;
}

export type ProcessOutputChunk = { stream: 'stdout' | 'stderr'; text: string };

/**
 * A running command. Output is buffered from spawn time, so a new owner (the
 * `CommandTaskWorker` adopting a backgrounded command) can replay everything
 * written so far and keep following.
 */
export abstract class WorkspaceProcess {
  abstract readonly id: string;
  abstract readonly command: string;
  abstract readonly startedAt: string;
  /** Resolves once the process has exited (never rejects). */
  abstract readonly exited: Promise<ProcessExit>;
  abstract readonly running: boolean;

  /** Everything written so far, then live chunks until exit. */
  abstract output(): AsyncIterable<ProcessOutputChunk>;
  /** Bounded tails (default ~64 KB each). */
  abstract tail(maxBytes?: number): { stdout: string; stderr: string };
  /** SIGTERM the process group, then SIGKILL after `graceMs`. */
  abstract kill(graceMs?: number): Promise<ProcessExit>;
  abstract writeStdin(text: string): Promise<void>;
}

/**
 * A file being written in chunks. Bytes go to a temporary file beside the
 * target; `commit` renames it into place, `abort` removes it. A handle is used once.
 */
export interface WriteHandle {
  write(chunk: Uint8Array): Promise<void>;
  /** Moves the temporary file to `finalPath` (workspace-relative, must resolve inside the root). */
  commit(finalPath: string): Promise<void>;
  /** Discards the temporary file; safe to call after a failed `commit`. */
  abort(): Promise<void>;
}

export abstract class WorkspaceTransport {
  /** Path agents see as their working directory, for prompts (e.g. `/workspace`). */
  abstract readonly displayRoot: string;

  abstract stat(path: string): Promise<FileStat | null>;
  /** Workspace-relative path of the entry after following symlinks (the name a download reports). Rejects when it resolves outside the workspace. */
  abstract realPath(path: string): Promise<string>;
  abstract readFile(path: string): Promise<Uint8Array>;
  /** The whole text, or `limit` lines starting at the zero-based line `offset`. */
  abstract readText(path: string, options?: { offset?: number; limit?: number }): Promise<string>;
  /** Atomic (tmp + rename); creates parent directories. */
  abstract writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Opens a chunked write to `path`; the target is only replaced by `WriteHandle.commit`. Rejects when `path` is not contained. */
  abstract openWrite(path: string): Promise<WriteHandle>;
  /** Streams the whole file, or the inclusive `range` of it. Rejects before streaming when the path is not a contained regular file. */
  abstract readStream(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
  abstract deleteFile(path: string): Promise<void>;
  abstract makeDirectory(path: string): Promise<void>;
  /** Removes a directory only when it is empty; a missing or non-empty directory is left alone. */
  abstract removeEmptyDirectory(path: string): Promise<void>;
  abstract list(path: string): Promise<FileStat[]>;
  abstract glob(pattern: string, options?: GlobOptions): Promise<string[]>;
  abstract grep(pattern: string, options?: GrepOptions): Promise<GrepMatch[]>;

  /** Start a command inside the workspace (cwd under the root, unprivileged user). */
  abstract spawn(options: SpawnOptions): Promise<WorkspaceProcess>;

  /** Throws `WorkspacePathError` when an agent may not write `path` under `policy`. */
  abstract assertWritable(path: string, policy: WorkspaceAccessPolicy): void;
}

export class WorkspacePathError extends Error {
  constructor(
    readonly path: string,
    reason: string
  ) {
    super(`${path}: ${reason}`);
    this.name = 'WorkspacePathError';
  }
}
