import { Hono } from 'hono';
import type { LinkMetadata } from '../link-preview/link-description';

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
    if (!href || href.length > 4096) return Response.json({}, { status: 400 });
    try {
      return Response.json(await linkPreview(href), {
        headers: { 'Cache-Control': 'public, max-age=3600' },
      });
    } catch {
      // Preview failures do not prevent the original link from being displayed.
      return Response.json({}, { headers: { 'Cache-Control': 'public, max-age=60' } });
    }
  });

  return routes;
}
