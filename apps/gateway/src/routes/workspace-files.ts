import type { WorkspaceTransport } from '@artemis/workspace';
import { Hono } from 'hono';
import { basename } from 'node:path';
import { errorResponse } from '../http.ts';
import { describeWorkspaceFile } from '../workspace/describe.ts';

/** Read access to the agent's workspace: any file the agent or a user placed there. */
export function createWorkspaceFileRoutes(workspace: WorkspaceTransport): Hono {
  const routes = new Hono();

  /**
   * Any file in the workspace, by its workspace path: attachments, and the files
   * the agent shares in its replies. Viewable types display in the browser
   * (`?download` forces a download); every response is sandboxed, so no file
   * runs as a page of the app. PDFs and other types are always downloads.
   */
  // The router matches the rest of the URL as one named parameter and decodes it once.
  routes.get('/workspace/:path{.+}', async (c) => {
    const file = await describeWorkspaceFile(workspace, c.req.param('path'));
    if (!file) return errorResponse('File not found', 404);
    const plan = planWorkspaceResponse(
      file,
      c.req.method,
      c.req.query('download') !== undefined,
      c.req.raw.headers.get('range')
    );
    if (plan.range === false) return new Response(null, { status: 416, headers: plan.headers });
    if (plan.noBody) return new Response(null, { status: plan.status, headers: plan.headers });
    const stream = await workspace.readStream(file.path, plan.range ?? undefined);
    return new Response(stream, { status: plan.status, headers: plan.headers });
  });

  return routes;
}

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
    'Content-Security-Policy': 'sandbox',
  };
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

function parseByteRange(
  value: string | null,
  size: number
): { start: number; end: number } | null | false {
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
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start)
      return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
