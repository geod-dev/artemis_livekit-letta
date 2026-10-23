import type { WorkspaceTransport } from '@artemis/workspace';
import { createHash, randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { MAX_UPLOAD_BYTES } from '../attachments/attachment-policy';

/** The metadata a device file upload returns; only this enters the device's MCP result. */
export interface DeviceFileMetadata {
  name: string;
  size: number;
  sha256: string;
  /** Workspace-relative path of the stored file. */
  path: string;
}

/**
 * Stream a device's bytes into the workspace in chunks. `checkCall` throws when
 * the pending device call that asked for the file is no longer valid.
 */
export async function saveDeviceFile(
  workspace: WorkspaceTransport,
  request: Request,
  sourcePath: string,
  checkCall: () => void
): Promise<DeviceFileMetadata> {
  const name =
    posix
      .basename(win32.basename(sourcePath))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .slice(0, 180)
      .replace(/[. ]+$/, '') || 'file';
  const length = Number(request.headers.get('Content-Length'));
  if (
    !request.body ||
    !request.headers.has('Content-Length') ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_UPLOAD_BYTES
  )
    throw new Error(
      `Upload requires a Content-Length of at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`
    );
  const path = `data/device-files/${randomUUID()}/${name}`;
  const directory = posix.dirname(path);
  const upload = await workspace.openWrite(path);
  const hash = createHash('sha256');
  let size = 0;
  let committed = false;
  try {
    const reader = request.body.getReader();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]);
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        checkCall();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_UPLOAD_BYTES || size > length) throw new Error('File exceeds upload limit');
        hash.update(value);
        await upload.write(value);
      }
      checkCall();
      if (size !== length) throw new Error('Incomplete file upload');
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
    }
    checkCall();
    await upload.commit(path);
    committed = true;
    checkCall();
    return { name, size, sha256: hash.digest('hex'), path };
  } catch (error) {
    if (committed) await workspace.deleteFile(path).catch(() => {});
    else await upload.abort().catch(() => {});
    await workspace.removeEmptyDirectory(directory).catch(() => {});
    throw error;
  }
}
