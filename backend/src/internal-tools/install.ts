/**
 * Keeping the backend's mods on disk and loaded.
 *
 * Letta loads global mods once, on the first client connection, and again only
 * on the `reload` command; it does not watch the directory. So the backend
 * renders every mod, writes only the ones that differ from disk, and sends one
 * `reload` for the batch. A Letta restart needs neither: the files are already
 * there when the first connection loads them.
 */

export interface ModsIo {
  /** File contents, or null when the file does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  /** `execute_command reload`. It needs an agent runtime, so this is false while none exists. */
  reloadMods(): Promise<boolean>;
}

export interface RenderedMod {
  path: string;
  source: string;
}

export type ModSyncResult = 'unchanged' | 'reloaded' | 'reload-pending';

// A failed reload remains work to do even when the rendered files now match.
const reloadPending = new WeakSet<ModsIo>();

export async function syncMods(io: ModsIo, mods: readonly RenderedMod[]): Promise<ModSyncResult> {
  let changed = false;
  for (const mod of mods) {
    if ((await io.read(mod.path)) === mod.source) continue;
    await io.write(mod.path, mod.source);
    changed = true;
  }
  if (!changed && !reloadPending.has(io)) return 'unchanged';
  if (await io.reloadMods()) {
    reloadPending.delete(io);
    return 'reloaded';
  }
  reloadPending.add(io);
  return 'reload-pending';
}
