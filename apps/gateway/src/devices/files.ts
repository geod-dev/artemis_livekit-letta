import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';

export const MAX_DEVICE_FILE_BYTES = 25 * 1024 * 1024;

/** Stream bytes to disk; only the resulting metadata ever enters an MCP result. */
export async function saveDeviceFile(
  request: Request,
  sourcePath: string,
  workspace: string,
  checkCall: () => void
) {
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
    length > MAX_DEVICE_FILE_BYTES
  )
    throw new Error('Upload requires a Content-Length of at most 25 MB');
  const path = `data/device-files/${randomUUID()}/${name}`;
  const directory = join(workspace, posix.dirname(path));
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, '.upload');
  const hash = createHash('sha256');
  let size = 0;
  try {
    const file = await open(temporary, 'wx');
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
        if (size > MAX_DEVICE_FILE_BYTES || size > length)
          throw new Error('File exceeds upload limit');
        hash.update(value);
        let offset = 0;
        while (offset < value.length) {
          const written = await file.write(value, offset, value.length - offset);
          offset += written.bytesWritten;
        }
      }
      checkCall();
      if (size !== length) throw new Error('Incomplete file upload');
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
      await file.close();
    }
    checkCall();
    await rename(temporary, join(workspace, path));
    checkCall();
    return {
      name,
      size,
      sha256: hash.digest('hex'),
      path,
      workspacePath: `/workspace/${path}`,
      link: `[Download file](${path
        .split('/')
        .map(encodeURIComponent)
        .join('/')
        .replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16))})`,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
