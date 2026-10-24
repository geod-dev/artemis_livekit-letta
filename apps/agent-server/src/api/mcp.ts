import { AppError } from '@artemis/core';
import type { McpServer } from '@artemis/contracts/chat-types';
import { type McpServerRegistry, InvalidMcpServersError } from '@artemis/mcp';
import { Hono } from 'hono';
import { ifMatchRevision, noContent } from './http.ts';
import { requireBody } from './validation.ts';

/** The port the MCP routes use. */
export interface McpRouteDeps {
  mcp: McpServerRegistry;
}

/** MCP settings (`/v1/mcp`) and the gateway's connection-managed servers (`/v1/mcp/managed`). */
export function mcpRoutes(deps: McpRouteDeps): Hono {
  const mcp = new Hono();

  mcp.get('/mcp', async () => {
    const settings = await deps.mcp.settings();
    return Response.json(settings, { headers: { ETag: `"${settings.revision}"` } });
  });

  mcp.put('/mcp', async (c) => {
    const expected = ifMatchRevision(c);
    if (!expected) throw new AppError('precondition_required', 'Reload MCP settings before saving (If-Match revision required)', 428);
    const body = await requireBody(c.req.raw);
    const settings = await deps.mcp.save(body.servers, expected);
    return Response.json(settings, { headers: { ETag: `"${settings.revision}"` } });
  });

  mcp.put('/mcp/managed', async (c) => {
    const body = await requireBody(c.req.raw);
    await deps.mcp.setManaged(managedServers(body.servers));
    return noContent();
  });

  return mcp;
}

/**
 * The gateway's list must be an array of objects, each with a string `name`; anything else is
 * a 400 (`InvalidMcpServersError` is an AppError with status 400). The registry checks the rest.
 */
function managedServers(value: unknown): McpServer[] {
  const wellFormed =
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry) && typeof (entry as { name?: unknown }).name === 'string');
  if (!wellFormed) throw new InvalidMcpServersError('servers must be an array of server objects, each with a string name');
  return value as McpServer[];
}
