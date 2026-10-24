import type { WorkspaceTransport } from '@artemis/workspace';
import { createHash, randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { MAX_UPLOAD_BYTES } from '../attachments/limits.ts';
import {
  DeviceBadRequest,
  DeviceError,
  DeviceRequestTooLarge,
  DeviceTimeout,
  DeviceUploadCancelled,
} from './errors.ts';

/** The metadata a device file upload returns; only this enters the device's MCP result. */
interface DeviceFileMetadata {
  name: string;
  size: number;
  sha256: string;
  /** Workspace-relative path of the stored file. */
  path: string;
}

/** How long one device file may take to arrive, from its first byte to its last. */
const UPLOAD_TIMEOUT_MS = 55_000;
/** Where device exports are stored: one directory per export. */
const DEVICE_FILE_DIRECTORY = 'data/device-files';
/**
 * How long a device export stays in the workspace. The same window as the
 * attachment abandonment rule (`ABANDONED_AFTER_MS` in attachment-registry.ts).
 */
const DEVICE_FILE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Removes device exports older than the retention window and returns how many were
 * removed. An export is one directory, so its modification time is its upload time.
 */
export async function sweepDeviceFiles(
  workspace: WorkspaceTransport,
  now = Date.now()
): Promise<number> {
  if ((await workspace.stat(DEVICE_FILE_DIRECTORY))?.type !== 'directory') return 0;
  let removed = 0;
  for (const entry of await workspace.list(DEVICE_FILE_DIRECTORY)) {
    if (entry.type !== 'directory' || now - Date.parse(entry.modifiedAt) < DEVICE_FILE_RETENTION_MS)
      continue;
    for (const file of await workspace.list(entry.path))
      if (file.type === 'file') await workspace.deleteFile(file.path);
    await workspace.removeEmptyDirectory(entry.path);
    removed += 1;
  }
  return removed;
}

/**
 * Stream a device's bytes into the workspace in chunks. `checkCall` throws when
 * the pending device call that asked for the file is no longer valid. Each upload
 * first sweeps the old exports; a failed sweep is logged and does not fail the upload.
 *
 * Client-facing failures are DeviceErrors (400 for a malformed or incomplete upload,
 * 413 for an oversize one, 408 for a timeout, 499 for a client that left). Any
 * other failure is an unexpected I/O error and reaches the caller unchanged.
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
    length < 0
  )
    throw new DeviceBadRequest('Upload requires a Content-Length header');
  if (length > MAX_UPLOAD_BYTES) throw tooLarge();
  await sweepDeviceFiles(workspace).catch((error) =>
    console.error('[devices] sweeping old device exports failed', error)
  );
  const path = `${DEVICE_FILE_DIRECTORY}/${randomUUID()}/${name}`;
  const directory = posix.dirname(path);
  const upload = await workspace.openWrite(path);
  const hash = createHash('sha256');
  const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  const signal = AbortSignal.any([request.signal, timeout]);
  let size = 0;
  let committed = false;
  try {
    const reader = request.body.getReader();
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
        if (size > MAX_UPLOAD_BYTES) throw tooLarge();
        if (size > length)
          throw new DeviceBadRequest('Upload is longer than its Content-Length header');
        hash.update(value);
        await upload.write(value);
      }
      checkCall();
      if (size !== length) throw new DeviceBadRequest('Incomplete file upload');
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
    throw uploadFailure(error, request, timeout);
  }
}

function tooLarge(): DeviceRequestTooLarge {
  return new DeviceRequestTooLarge(
    `File is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit`
  );
}

/** The error an upload reports: a timeout or a departed client is named; everything else passes through. */
function uploadFailure(error: unknown, request: Request, timeout: AbortSignal): unknown {
  if (error instanceof DeviceError) return error;
  if (timeout.aborted) return new DeviceTimeout('Upload timed out');
  if (request.signal.aborted) return new DeviceUploadCancelled('Upload was cancelled');
  return error;
}
