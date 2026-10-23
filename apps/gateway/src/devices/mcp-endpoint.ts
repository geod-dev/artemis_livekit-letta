import { handleDeviceMcpRequest } from '@artemis/mcp/device-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DeviceHub } from './hub';

/**
 * One authenticated, standard Streamable HTTP MCP endpoint per connected device.
 * The protocol handling lives in `@artemis/mcp/device-server`; this route only
 * authenticates the device and binds its tools and calls to the hub.
 */
export function createDeviceMcpRoutes(hub: DeviceHub): Hono {
  const routes = new Hono();
  routes.use('*', bodyLimit({ maxSize: 256_000 }));
  routes.all('/:name', (c) => {
    const name = c.req.param('name');
    const session = hub.authenticate(name, c.req.header('Authorization') ?? '');
    if (!session) return c.json({ error: 'Unauthorized or disconnected device' }, 401);
    return handleDeviceMcpRequest(c.req.raw, {
      serverName: `device_${name}`,
      tools: () => hub.tools(name, session),
      call: (tool, args) => hub.call(name, session, tool, args),
    });
  });
  return routes;
}
