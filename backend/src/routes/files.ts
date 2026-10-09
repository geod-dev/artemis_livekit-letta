import { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { fileType, saveAttachment, workspaceFile } from '../assistant/workspace';
import { errorResponse } from '../http';

/** Files: attachment uploads, and read access to the agent's workspace. */
export const files = new Hono();

/** Upload one file (multipart field `file`) as an attachment. */
files.post('/attachments', async (c) => {
  const file = (await c.req.formData().catch(() => null))?.get('file');
  if (!file || typeof file === 'string') return errorResponse('file is required', 400);
  try {
    return Response.json(await saveAttachment(file), { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
});

/**
 * Any file in the workspace, by its workspace path: attachments, and the files
 * the agent shares in its replies. Viewable types display in the browser
 * (`?download` forces a download); text formats are served as plain text and
 * every response is sandboxed, so no file runs as a page of the app. PDFs are
 * exempt from the sandbox, which would block the browser's PDF viewer.
 */
files.get('/workspace/*', async (c) => {
  const encoded = new URL(c.req.url).pathname.replace(/^\/api\/workspace\//, '');
  const file = await workspaceFile(safeDecode(encoded));
  if (!file) return errorResponse('File not found', 404);
  const { contentType, viewable } = fileType(file.path);
  const disposition = viewable && c.req.query('download') === undefined ? 'inline' : 'attachment';
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(file.size),
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(basename(file.path))}`,
    'X-Content-Type-Options': 'nosniff',
    // The agent may rewrite a file under the same path.
    'Cache-Control': 'no-cache',
  };
  if (contentType !== 'application/pdf') headers['Content-Security-Policy'] = 'sandbox';
  // Hono answers HEAD with this handler; do not open the file for it.
  if (c.req.method === 'HEAD') return new Response(null, { headers });
  const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>;
  return new Response(body, { headers });
});

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return '';
  }
}
