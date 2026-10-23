import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type DeviceHub, deviceHub } from './hub';

/** One authenticated, standard Streamable HTTP MCP endpoint per connected device. */
export function createDeviceMcpRoutes(hub: DeviceHub): Hono {
  const routes = new Hono();
  routes.use('*', bodyLimit({ maxSize: 256_000 }));
  routes.all('/:name', async (c) => {
    const name = c.req.param('name');
    const session = hub.authenticate(name, c.req.header('Authorization') ?? '');
    if (!session) return c.json({ error: 'Unauthorized or disconnected device' }, 401);
    const server = new Server(
      { name: `device_${name}`, version: '1' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: hub.tools(name, session),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      hub.call(name, session, request.params.name, request.params.arguments ?? {})
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  return routes;
}
export const deviceMcp = createDeviceMcpRoutes(deviceHub);
