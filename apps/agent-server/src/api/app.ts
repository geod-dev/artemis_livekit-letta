import { errorResponse } from '@artemis/http';
import { Hono } from 'hono';
import { conversationRoutes } from './conversations.ts';
import type { ApiDependencies } from './deps.ts';
import { requireBearer } from './http.ts';
import { mcpRoutes } from './mcp.ts';
import { voiceRoutes } from './voice.ts';

/**
 * Hono app (routes: docs/architecture.md, "How the services talk"). Everything under `/v1`
 * requires `Authorization: Bearer AGENT_SERVER_TOKEN`; `/health` and `/ready` are open.
 * Errors map through `errorResponse` (AppError/HttpError keep their status and
 * code, 5xx hide the message behind a request id).
 */
export function createApp(deps: ApiDependencies): Hono {
  const app = new Hono();

  app.onError((error) => errorResponse(error));
  app.notFound(() => Response.json({ error: 'Not found', code: 'not_found' }, { status: 404 }));

  app.get('/health', () => Response.json({ status: 'ok' }));

  app.get('/ready', async () => {
    const parts = await deps.ready();
    const status = !parts.storage ? 'unavailable' : parts.mcp && parts.memory ? 'ok' : 'degraded';
    return Response.json(
      { status, ...parts },
      { status: status === 'unavailable' ? 503 : 200 }
    );
  });

  const v1 = new Hono();
  v1.use('*', requireBearer(deps.config.token));
  v1.route('/', conversationRoutes(deps));
  v1.route('/', mcpRoutes(deps));
  v1.route('/voice', voiceRoutes(deps));
  app.route('/v1', v1);

  return app;
}
