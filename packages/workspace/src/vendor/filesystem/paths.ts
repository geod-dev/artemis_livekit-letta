import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { WorkspacePathError } from '../../transport.ts';

/**
 * Workspace-relative POSIX path for an agent-supplied path: `''` is the root.
 * `displayRoot`-prefixed paths (`/workspace/files/x`) are accepted; absolute
 * paths and anything leaving the root lexically are rejected. Symlinks are
 * checked against the disk by `WorkspaceContainment`.
 *
 * On win32 `\` is also a separator (converted to `/` before the checks), so
 * `..\victim.txt` is an escape there. On POSIX `\` is a filename character.
 */
export function toRelativePath(
  input: string,
  displayRoot: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (input.includes('\0')) throw new WorkspacePathError(input, 'invalid character in path');
  const windows = platform === 'win32';
  let path = windows ? input.replace(/\\/g, '/') : input;
  const prefix = displayRoot.replace(/\/+$/, '');
  if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) {
    path = path.slice(prefix.length).replace(/^\/+/, '');
  }
  // `C:foo` is drive-relative on win32: it is refused like an absolute path.
  const absolute = windows ? /^[A-Za-z]:/.test(path) : isAbsolute(path);
  if (path.startsWith('/') || absolute) {
    throw new WorkspacePathError(
      input,
      'absolute paths are not allowed; use a path relative to the workspace'
    );
  }
  const normalized = posix.normalize(path === '' ? '.' : path);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new WorkspacePathError(input, 'path leaves the workspace');
  }
  return normalized === '.' ? '' : normalized.replace(/\/+$/, '');
}

/**
 * True when workspace-relative `rel` is `prefix` or lies beneath it. Both are
 * already `toRelativePath` output. Windows compares case-insensitively (NTFS).
 */
export function isUnderPrefix(
  rel: string,
  prefix: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const fold =
    platform === 'win32' ? (value: string) => value.toLowerCase() : (value: string) => value;
  const target = fold(rel);
  const base = fold(prefix);
  return target === base || target.startsWith(`${base}/`);
}

/** True when `path` is `root` or lies beneath it (both absolute, already resolved). */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Maps workspace-relative paths onto the host and enforces containment against
 * the real filesystem: every path that is touched must resolve (through `..`
 * and symlinks) inside the canonical root.
 */
export class WorkspaceContainment {
  /** `root` must be absolute. */
  constructor(readonly root: string) {}

  /** Lexical host path of a workspace-relative path. Touch the disk only through the methods below. */
  host(rel: string): string {
    return rel === '' ? this.root : join(this.root, ...rel.split('/'));
  }

  /** Canonical root (symlinks resolved). */
  realRoot(): Promise<string> {
    return realpath(this.root);
  }

  /** Canonical host path of an existing entry; `WorkspacePathError` when it resolves outside the root. */
  async existing(rel: string): Promise<string> {
    const real = await realpath(this.host(rel));
    return this.assertInside(rel, real);
  }

  /** Canonical host path of an existing directory. */
  async directory(rel: string): Promise<string> {
    const real = await this.existing(rel);
    if (!(await stat(real)).isDirectory())
      throw new WorkspacePathError(rel || '.', 'not a directory');
    return real;
  }

  /**
   * Host path to create or replace `rel`. Existing ancestors must resolve inside
   * the root, and an existing final entry (even a symlink) must too; the
   * missing tail is created under the canonical ancestor.
   */
  async forWrite(rel: string): Promise<string> {
    if (rel === '') throw new WorkspacePathError('.', 'the workspace root is not a file');
    const missing: string[] = [];
    let probe = this.host(rel);
    while (!(await lstatOrNull(probe))) {
      missing.unshift(basename(probe));
      const parent = dirname(probe);
      if (parent === probe) throw new WorkspacePathError(rel, 'workspace root is missing');
      probe = parent;
    }
    const base = await realpath(probe).catch((error: unknown) => {
      if (isNotFound(error)) throw new WorkspacePathError(rel, 'dangling symbolic link');
      throw error;
    });
    return this.assertInside(rel, join(base, ...missing));
  }

  private async assertInside(rel: string, real: string): Promise<string> {
    if (!isWithin(await this.realRoot(), real)) {
      throw new WorkspacePathError(rel || '.', 'resolves outside the workspace');
    }
    return real;
  }
}

export async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Renders a host path found by a tool (`glob`, `rg`) as a workspace-relative POSIX path. */
export function toPosix(path: string): string {
  return path.split(sep).join('/');
}
