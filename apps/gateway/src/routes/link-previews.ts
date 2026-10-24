import { Hono } from 'hono';
import { errorResponse } from '../http.ts';
import type { LinkMetadata } from '../link-preview/link-description.ts';

/**
 * Title and description of a public page linked in a message. The fetcher is
 * injected; it refuses private destinations and returns metadata or throws.
 */
export function createLinkPreviewRoutes({
  linkPreview,
}: {
  linkPreview: (href: string) => Promise<LinkMetadata>;
}): Hono {
  const routes = new Hono();

  routes.get('/link-preview', async (c) => {
    const href = c.req.query('url');
    if (!href || href.length > 4096) return errorResponse('url is required', 400);
    try {
      return Response.json(await linkPreview(href));
    } catch (error) {
      // Preview failures do not prevent the original link from being displayed; the reason is logged for debugging.
      console.debug('[link-preview] no preview for a link', error);
      return Response.json({});
    }
  });

  return routes;
}
