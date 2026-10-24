import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type AgentServerClient, GatewayClientError } from '../agent-server/client.ts';
import { PROXY_BODY_LIMIT, routeError } from '../http.ts';

/** The shared MCP server list: the agent-server validates, stores and reports it. */
export function createMcpRoutes(agent: AgentServerClient): Hono {
  const mcp = new Hono();
  mcp.onError(routeError);
  mcp.use('*', bodyLimit({ maxSize: PROXY_BODY_LIMIT }));
  mcp.get('/', async (c) => withoutDeviceCredentials(await agent.relay(c.req.raw, '/v1/mcp')));
  mcp.put('/', (c) => agent.relay(c.req.raw, '/v1/mcp'));
  return mcp;
}

/**
 * A connected device's server carries the bearer key the agent-server calls it with.
 * The browser never needs that key, so it is removed from the settings it reads.
 * A successful answer that is not the expected settings object is refused.
 */
async function withoutDeviceCredentials(upstream: Response): Promise<Response> {
  if (!upstream.ok) return upstream;
  const settings = (await upstream.json().catch(() => null)) as unknown;
  if (
    typeof settings !== 'object' ||
    settings === null ||
    !Array.isArray((settings as { servers?: unknown }).servers)
  )
    throw new GatewayClientError('Agent server returned invalid MCP settings', 502);
  const body = settings as { servers: unknown[] };
  const headers = new Headers(upstream.headers);
  headers.delete('content-length');
  return new Response(
    JSON.stringify({ ...body, servers: body.servers.map(withoutDeviceHeaders) }),
    {
      status: upstream.status,
      headers,
    }
  );
}

function withoutDeviceHeaders(server: unknown): unknown {
  if (typeof server !== 'object' || server === null) return server;
  const managed = (server as { managed?: { type?: unknown } }).managed;
  if (managed?.type !== 'device') return server;
  const copy: Record<string, unknown> = { ...server };
  delete copy.headers;
  return copy;
}
