import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  glob as globFiles,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type FileStat,
  type GlobOptions,
  type GrepMatch,
  type GrepOptions,
  type SpawnOptions,
  type WorkspaceAccessPolicy,
  WorkspacePathError,
  type WorkspaceProcess,
  WorkspaceTransport,
} from '../transport.ts';
import { isWithin, lstatOrNull, toPosix, toRelativePath, WorkspaceContainment } from './paths.ts';
import { startProcess } from './process.ts';
import { TextSearch } from './search.ts';

export interface FilesystemWorkspaceOptions {
  /** Absolute host path of the workspace root. */
  root: string;
  /** Shown to the model, e.g. `/workspace`. Defaults to `root`. */
  displayRoot?: string;
  /** Run commands as this uid/gid (the container's unprivileged `workspace` user). POSIX only. */
  runAs?: { uid: number; gid: number };
  /** Shell used for `spawn` (`-lc`). Default `/bin/bash` on POSIX, `bash` (from PATH, e.g. Git Bash) on Windows. */
  shell?: string;
  /** Extra environment for every command (e.g. `PATH` with the Python venv). Merged over the inherited basics. */
  env?: Record<string, string>;
  /** `auto` uses `rg` when it is on the PATH; `off` always uses the JavaScript search. */
  ripgrep?: 'auto' | 'off';
  /** Maximum wall-clock lifetime of a command without its own `timeoutMs` (background, interactive). Default 30 minutes. */
  commandLifetimeMs?: number;
  /** Retained output per command stream. Default 1 MiB; the oldest output is dropped. */
  maxOutputBytes?: number;
}

const DEFAULT_GREP_LIMIT = 500;
const DEFAULT_GLOB_LIMIT = 1_000;
const DEFAULT_GLOB_IGNORE = ['.git/**', 'node_modules/**'];
/** Environment variables commands inherit from the server; everything else (API keys, DATABASE_URL) stays out. */
const INHERITED_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'USERPROFILE',
  'PATHEXT',
  'COMSPEC',
]);

/** Local directory + local processes (`node:fs/promises`, `node:child_process` with process groups or `taskkill` trees). */
export class FilesystemWorkspaceTransport extends WorkspaceTransport {
  readonly displayRoot: string;
  private readonly containment: WorkspaceContainment;
  private readonly search: TextSearch;

  constructor(readonly options: FilesystemWorkspaceOptions) {
    super();
    this.displayRoot = options.displayRoot ?? options.root;
    this.containment = new WorkspaceContainment(options.root);
    this.search = new TextSearch(options.ripgrep ?? 'auto');
  }

  async stat(path: string): Promise<FileStat | null> {
    const rel = this.rel(path);
    const link = await lstatOrNull(this.containment.host(rel));
    if (!link) return null;
    let info = link;
    if (link.isSymbolicLink()) {
      // Symlinks are followed for the report, but never outside the root.
      const target = await this.containment.existing(rel).catch(() => null);
      if (target) info = await stat(target);
    }
    return fileStat(rel, info);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const rel = this.rel(path);
    const real = await this.containment.existing(rel);
    if (!(await stat(real)).isFile()) throw new Error(`${path}: not a regular file`);
    return readFile(real);
  }

  async readText(path: string, options: { offset?: number; limit?: number } = {}): Promise<string> {
    const text = Buffer.from(await this.readFile(path)).toString('utf8');
    if (options.offset === undefined && options.limit === undefined) return text;
    const lines = text.split('\n');
    const start = options.offset ?? 0;
    const end = options.limit === undefined ? lines.length : start + options.limit;
    return lines.slice(start, end).join('\n');
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const target = await this.containment.forWrite(this.rel(path));
    await mkdir(dirname(target), { recursive: true });
    // Write beside the target, then rename over it: readers never see a partial file.
    const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
    await writeFile(temporary, data, { flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async deleteFile(path: string): Promise<void> {
    const rel = this.rel(path);
    if (rel === '') throw new WorkspacePathError('.', 'the workspace root cannot be deleted');
    await this.containment.directory(parentOf(rel));
    const entry = await lstat(this.containment.host(rel));
    if (entry.isDirectory()) throw new Error(`${path}: is a directory`);
    await unlink(this.containment.host(rel));
  }

  async makeDirectory(path: string): Promise<void> {
    const target = await this.containment.forWrite(this.rel(path));
    await mkdir(target, { recursive: true });
  }

  async list(path: string): Promise<FileStat[]> {
    const rel = this.rel(path);
    const dir = await this.containment.directory(rel);
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    return Promise.all(
      entries.map(async (entry) => fileStat(joinRel(rel, entry.name), await lstat(join(dir, entry.name))))
    );
  }

  async glob(pattern: string, options: GlobOptions = {}): Promise<string[]> {
    const cwdRel = this.rel(options.cwd ?? '');
    const dir = await this.containment.directory(cwdRel);
    const root = await this.containment.realRoot();
    const limit = options.limit ?? DEFAULT_GLOB_LIMIT;
    const found: string[] = [];
    for await (const match of globFiles(pattern, { cwd: dir, exclude: options.ignore ?? DEFAULT_GLOB_IGNORE })) {
      if (found.length >= limit) break;
      // Results outside the root (through a symlink) are dropped.
      const real = await realpath(join(dir, match)).catch(() => null);
      if (!real || !isWithin(root, real)) continue;
      found.push(joinRel(cwdRel, toPosix(match)));
    }
    return found.sort();
  }

  async grep(pattern: string, options: GrepOptions = {}): Promise<GrepMatch[]> {
    // `contextLines` is not supported: a GrepMatch carries one line.
    const dir = await this.containment.directory(this.rel(options.path ?? ''));
    return this.search.grep({
      pattern,
      root: await this.containment.realRoot(),
      dir,
      include: options.include,
      caseInsensitive: options.caseInsensitive,
      limit: options.limit ?? DEFAULT_GREP_LIMIT,
    });
  }

  async spawn(options: SpawnOptions): Promise<WorkspaceProcess> {
    const cwd = await this.containment.directory(this.rel(options.cwd ?? ''));
    return startProcess({
      command: options.command,
      shell: this.options.shell ?? (process.platform === 'win32' ? 'bash' : '/bin/bash'),
      cwd,
      env: this.commandEnv(options.env),
      timeoutMs: options.timeoutMs,
      maxLifetimeMs: this.options.commandLifetimeMs,
      maxOutputBytes: this.options.maxOutputBytes,
      runAs: this.options.runAs,
    });
  }

  assertWritable(path: string, policy: WorkspaceAccessPolicy): void {
    const rel = this.rel(path);
    for (const prefix of policy.readOnlyPrefixes) {
      const readOnly = toRelativePath(prefix, '');
      if (readOnly && (rel === readOnly || rel.startsWith(`${readOnly}/`))) {
        throw new WorkspacePathError(path, 'read-only in this workspace');
      }
    }
  }

  private rel(path: string): string {
    return toRelativePath(path, this.displayRoot);
  }

  private commandEnv(extra: Record<string, string> | undefined): Record<string, string> {
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && INHERITED_ENV.has(key.toUpperCase())) inherited[key] = value;
    }
    return { ...inherited, ...this.options.env, ...extra };
  }
}

function fileStat(path: string, info: Stats): FileStat {
  return {
    path,
    type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other',
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
}

function parentOf(rel: string): string {
  const index = rel.lastIndexOf('/');
  return index === -1 ? '' : rel.slice(0, index);
}

function joinRel(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}
