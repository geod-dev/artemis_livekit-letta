import { notImplemented } from '@artemis/core';
import {
  type FileStat,
  type GlobOptions,
  type GrepMatch,
  type GrepOptions,
  type SpawnOptions,
  type WorkspaceAccessPolicy,
  type WorkspaceProcess,
  WorkspaceTransport,
} from '../transport.ts';

export interface FilesystemWorkspaceOptions {
  /** Absolute host path of the workspace root. */
  root: string;
  /** Shown to the model, e.g. `/workspace`. Defaults to `root`. */
  displayRoot?: string;
  /** Run commands as this uid/gid (the container's unprivileged `workspace` user). */
  runAs?: { uid: number; gid: number };
  /** Shell used for `spawn` (default `/bin/bash`, `-lc`). */
  shell?: string;
  /** Extra environment for every command (e.g. `HOME`, `PATH` with the Python venv). */
  env?: Record<string, string>;
}

/** Local directory + local processes (`node:fs/promises`, `node:child_process` with process groups). */
export class FilesystemWorkspaceTransport extends WorkspaceTransport {
  readonly displayRoot: string;

  constructor(readonly options: FilesystemWorkspaceOptions) {
    super();
    this.displayRoot = options.displayRoot ?? options.root;
  }

  stat(_path: string): Promise<FileStat | null> {
    return notImplemented('FilesystemWorkspaceTransport.stat');
  }
  readFile(_path: string): Promise<Uint8Array> {
    return notImplemented('FilesystemWorkspaceTransport.readFile');
  }
  readText(_path: string, _options?: { offset?: number; limit?: number }): Promise<string> {
    return notImplemented('FilesystemWorkspaceTransport.readText');
  }
  writeFile(_path: string, _data: Uint8Array | string): Promise<void> {
    return notImplemented('FilesystemWorkspaceTransport.writeFile');
  }
  deleteFile(_path: string): Promise<void> {
    return notImplemented('FilesystemWorkspaceTransport.deleteFile');
  }
  makeDirectory(_path: string): Promise<void> {
    return notImplemented('FilesystemWorkspaceTransport.makeDirectory');
  }
  list(_path: string): Promise<FileStat[]> {
    return notImplemented('FilesystemWorkspaceTransport.list');
  }
  glob(_pattern: string, _options?: GlobOptions): Promise<string[]> {
    return notImplemented('FilesystemWorkspaceTransport.glob');
  }
  grep(_pattern: string, _options?: GrepOptions): Promise<GrepMatch[]> {
    return notImplemented('FilesystemWorkspaceTransport.grep');
  }
  spawn(_options: SpawnOptions): Promise<WorkspaceProcess> {
    return notImplemented('FilesystemWorkspaceTransport.spawn');
  }
  assertWritable(_path: string, _policy: WorkspaceAccessPolicy): void {
    notImplemented('FilesystemWorkspaceTransport.assertWritable');
  }
}
