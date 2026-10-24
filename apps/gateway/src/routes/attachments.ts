import { Hono } from 'hono';
import { InvalidAttachmentError, PayloadTooLargeError } from '../attachments/attachment-policy.ts';
import type { AttachmentStore } from '../attachments/attachment-store.ts';
import { MAX_UPLOAD_BYTES } from '../attachments/limits.ts';
import { errorResponse, requestLimit } from '../http.ts';

/** Multipart framing around a file is small; the limit counts the whole request body. */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/** Composer attachments: upload one file, and discard it while no conversation uses it. */
export function createAttachmentRoutes(attachments: AttachmentStore): Hono {
  const routes = new Hono();

  /** Upload one file (multipart field `file`) as an attachment. */
  routes.post(
    '/attachments',
    requestLimit(MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES),
    async (c) => {
      const form = await c.req.raw.formData().catch(() => null);
      const file = form?.get('file');
      if (!file || typeof file === 'string') return errorResponse('file is required', 400);
      try {
        return Response.json(await attachments.save(file), { status: 201 });
      } catch (error) {
        if (error instanceof PayloadTooLargeError) return errorResponse(error.message, 413);
        if (error instanceof InvalidAttachmentError) return errorResponse(error.message, 400);
        return errorResponse(error, 500);
      }
    }
  );

  /** Discard an uploaded composer file if no conversation has used it. */
  routes.delete('/attachments', async (c) => {
    const path = c.req.query('path') ?? '';
    if (path.length > 500) return errorResponse('Invalid attachment path', 400);
    try {
      await attachments.registry.removeUnused(path);
    } catch (error) {
      // A failed removal is reported, so the client knows the upload may still exist.
      return errorResponse(error, 500);
    }
    return new Response(null, { status: 204 });
  });

  return routes;
}
