import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { workspaceUrl } from '@/lib/attachments';
import { TtlLruCache } from '@/lib/ttl-lru-cache';

export type FileInfo = { status: 'ready'; type: string; size: number } | { status: 'missing' };

const FILE_INFO_TTL_MS = 60_000;
const FILE_INFO_CACHE_SIZE = 128;
const FILE_INFO_IN_FLIGHT_LIMIT = 64;
const fileInfoCache = new TtlLruCache<string, FileInfo & { status: 'ready' }>(
  FILE_INFO_CACHE_SIZE,
  FILE_INFO_TTL_MS
);
const infoRequests = new Map<string, Promise<FileInfo>>();

/** Invalidate metadata after opening or changing a workspace file. */
export function invalidateWorkspaceFileInfo(path?: string): void {
  if (path) {
    fileInfoCache.delete(path);
    infoRequests.delete(path);
  } else {
    fileInfoCache.clear();
    infoRequests.clear();
  }
}

/** The file's type and size, from a HEAD request (missing files are asked again). */
function fileInfo(path: string): Promise<FileInfo> {
  const cached = fileInfoCache.get(path);
  if (cached) return Promise.resolve(cached);
  let pending = infoRequests.get(path);
  if (!pending) {
    pending = apiFetch(workspaceUrl(path), { method: 'HEAD' })
      .then((res): FileInfo => {
        if (!res.ok) return { status: 'missing' };
        return {
          status: 'ready',
          type: (res.headers.get('content-type') ?? '').split(';')[0] ?? '',
          size: Number(res.headers.get('content-length') ?? 0),
        };
      })
      .catch((): FileInfo => ({ status: 'missing' }));
    if (infoRequests.size >= FILE_INFO_IN_FLIGHT_LIMIT) {
      const oldest = infoRequests.keys().next().value;
      if (oldest !== undefined) infoRequests.delete(oldest);
    }
    infoRequests.set(path, pending);
    void pending.then((info) => {
      if (infoRequests.get(path) !== pending) return;
      if (info.status === 'ready') fileInfoCache.set(path, info);
      infoRequests.delete(path);
    });
  }
  return pending;
}

export function useFileInfo(path: string): FileInfo | null {
  const [entry, setEntry] = useState<{ path: string; info: FileInfo } | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = (event: Event) => {
      const changedPath = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (changedPath && changedPath !== path) return;
      invalidateWorkspaceFileInfo(path);
      void fileInfo(path).then((info) => {
        if (active) setEntry({ path, info });
      });
    };
    void fileInfo(path).then((info) => {
      if (active) setEntry({ path, info });
    });
    window.addEventListener('workspace-file-changed', refresh);
    return () => {
      active = false;
      window.removeEventListener('workspace-file-changed', refresh);
    };
  }, [path]);
  return entry?.path === path ? entry.info : null;
}
