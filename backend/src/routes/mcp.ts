import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AgentServerClient } from '../agent-server/client';
import { PROXY_BODY_LIMIT, routeError } from '../http';

/** The shared MCP server list: the agent-server validates, stores and reports it. */
export function createMcpRoutes(agent: AgentServerClient): Hono {
  const mcp = new Hono();
  mcp.onError(routeError);
  mcp.use('*', bodyLimit({ maxSize: PROXY_BODY_LIMIT }));
  mcp.get('/', (c) => agent.relay(c.req.raw, '/v1/mcp'));
  mcp.put('/', (c) => agent.relay(c.req.raw, '/v1/mcp'));
  return mcp;
}
