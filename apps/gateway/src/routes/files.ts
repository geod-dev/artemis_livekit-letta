import { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { MAX_ATTACHMENT_BYTES, saveAttachment, workspaceFile } from '../assistant/filesystem/workspace-adapter.ts';
import { removeUnusedAttachment } from '../assistant/filesystem/attachment-retention';
import { errorResponse } from '../http';

/** Files: attachment uploads, and read access to the agent's workspace. */
export const files = new Hono();

/** Upload one file (multipart field `file`) as an attachment. */
files.post('/attachments', async (c) => {
  const bounded = await readBoundedBody(c.req.raw, MAX_ATTACHMENT_BYTES + 1024 * 1024);
  if (!bounded.ok) return errorResponse(bounded.error, bounded.status);
  const request = new Request(c.req.url, { method: 'POST', headers: c.req.raw.headers, body: new Uint8Array(bounded.body) });
  const file = (await request.formData().catch(() => null))?.get('file');
  if (!file || typeof file === 'string') return errorResponse('file is required', 400);
  if (file.size > MAX_ATTACHMENT_BYTES) return errorResponse('File is larger than 25 MB', 413);
  try {
    return Response.json(await saveAttachment(file), { status: 201 });
  } catch (error) {
    return errorResponse(error, error instanceof Error && /25 MB/.test(error.message) ? 413 : 400);
  }
});

/** Discard an uploaded composer file if no conversation has used it. */
files.delete('/attachments', async (c) => {
  const path = c.req.query('path') ?? '';
  if (path.length > 500) return errorResponse('Invalid attachment path', 400);
  await removeUnusedAttachment(path).catch((error) => console.error('[files] attachment removal failed:', error));
  return new Response(null, { status: 204 });
});

/**
 * Any file in the workspace, by its workspace path: attachments, and the files
 * the agent shares in its replies. Viewable types display in the browser
 * (`?download` forces a download); text formats are served as plain text and
 * every response is sandboxed, so no file runs as a page of the app. PDFs are
 * exempt from the sandbox, which would block the browser's PDF viewer.
 */
files.get('/workspace/*', async (c) => {
  const path = c.req.path;
  const marker = path.indexOf('/workspace/');
  const encoded = marker >= 0 ? path.slice(marker + '/workspace/'.length) : '';
  const file = await workspaceFile(safeDecode(encoded));
  if (!file) return errorResponse('File not found', 404);
  const plan = planWorkspaceResponse(file, c.req.method, c.req.query('download') !== undefined, c.req.raw.headers.get('range'));
  if (plan.range === false) return new Response(null, { status: 416, headers: plan.headers });
  if (plan.noBody) return new Response(null, { status: plan.status, headers: plan.headers });
  const stream = Readable.toWeb(createReadStream(file.path, plan.range ? plan.range : {})) as ReadableStream<Uint8Array>;
  return new Response(stream, { status: plan.status, headers: plan.headers });
});

export function planWorkspaceResponse(
  file: { path: string; size: number; contentType: string; viewable: boolean },
  method: string,
  download: boolean,
  rangeHeader: string | null
): {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  range: { start: number; end: number } | null | false;
  noBody: boolean;
} {
  const { contentType, viewable } = file;
  const disposition = viewable && !download ? 'inline' : 'attachment';
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(basename(file.path))}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  };
  if (contentType !== 'application/pdf') headers['Content-Security-Policy'] = 'sandbox';
  const range = parseByteRange(rangeHeader, file.size);
  if (range === false) {
    headers['Content-Range'] = `bytes */${file.size}`;
    return { status: 416, headers, range, noBody: true };
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? file.size - 1;
  headers['Content-Length'] = String(range ? end - start + 1 : file.size);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
  return {
    status: range ? 206 : 200,
    headers,
    range,
    noBody: method === 'HEAD' || file.size === 0,
  };
}

function parseByteRange(value: string | null, size: number): { start: number; end: number } | null | false {
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size === 0 || (!match[1] && !match[2])) return false;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function readBoundedBody(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; body: Buffer } | { ok: false; status: number; error: string }> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    return { ok: false, status: 413, error: 'Request body is too large' };
  }
  if (!request.body) return { ok: true, body: Buffer.alloc(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: 'Request body is too large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { ok: false, status: 400, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, body: Buffer.concat(chunks, size) };
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return '';
  }
}
