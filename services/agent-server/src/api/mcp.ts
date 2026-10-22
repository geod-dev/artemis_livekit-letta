import { AppError } from '@artemis/core';
import { InvalidMcpServersError } from '@artemis/mcp';
import { Hono } from 'hono';
import type { McpServer } from '@artemis/contracts/chat-types';
import type { ApiDependencies } from './app.ts';
import { ifMatchRevision, noContent, requireBody } from './http.ts';

/** MCP settings (`/v1/mcp`) and the gateway's connection-managed servers (`/v1/mcp/managed`). */
export function mcpRoutes(deps: ApiDependencies): Hono {
  const mcp = new Hono();

  mcp.get('/mcp', async () => {
    const settings = await deps.mcp.settings();
    return Response.json(settings, { headers: { ETag: `"${settings.revision}"` } });
  });

  mcp.put('/mcp', async (c) => {
    const expected = ifMatchRevision(c);
    if (!expected) throw new AppError('precondition_required', 'Reload MCP settings before saving (If-Match revision required)', 428);
    const body = await requireBody(c.req.raw);
    const settings = await guardInvalid(() => deps.mcp.save(body.servers, expected));
    return Response.json(settings, { headers: { ETag: `"${settings.revision}"` } });
  });

  mcp.put('/mcp/managed', async (c) => {
    const body = await requireBody(c.req.raw);
    await guardInvalid(() => deps.mcp.setManaged(body.servers as McpServer[]));
    return noContent();
  });

  return mcp;
}

/** Validation failures of MCP servers are client errors (400). */
async function guardInvalid<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InvalidMcpServersError) throw new AppError('invalid_mcp_servers', error.message, 400);
    throw error;
  }
}
