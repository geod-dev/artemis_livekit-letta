import type { WorkspaceTransport } from '@artemis/workspace';
import { createHash, randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { MAX_UPLOAD_BYTES } from '../attachments/limits';
import { HttpError } from '../http';

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

/**
 * Stream a device's bytes into the workspace in chunks. `checkCall` throws when
 * the pending device call that asked for the file is no longer valid.
 *
 * Client-facing failures are HttpErrors (400 for a malformed or incomplete upload,
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
    throw new HttpError('Upload requires a Content-Length header', 400);
  if (length > MAX_UPLOAD_BYTES) throw tooLarge();
  const path = `data/device-files/${randomUUID()}/${name}`;
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
          throw new HttpError('Upload is longer than its Content-Length header', 400);
        hash.update(value);
        await upload.write(value);
      }
      checkCall();
      if (size !== length) throw new HttpError('Incomplete file upload', 400);
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

function tooLarge(): HttpError {
  return new HttpError(
    `File is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit`,
    413
  );
}

/** The error an upload reports: a timeout or a departed client is named; everything else passes through. */
function uploadFailure(error: unknown, request: Request, timeout: AbortSignal): unknown {
  if (error instanceof HttpError) return error;
  if (timeout.aborted) return new HttpError('Upload timed out', 408);
  if (request.signal.aborted) return new HttpError('Upload was cancelled', 499);
  return error;
}
