import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DeviceHub } from './hub.ts';

/**
 * One authenticated, standard Streamable HTTP MCP endpoint per connected device.
 * The hub authenticates the device and binds its tools and calls; the MCP protocol
 * handling is the injected `serve` of the hub's protocol.
 */
export function createDeviceMcpRoutes(hub: DeviceHub): Hono {
  const routes = new Hono();
  routes.use('*', bodyLimit({ maxSize: 256_000 }));
  routes.all('/:name', (c) => {
    const name = c.req.param('name');
    const session = hub.authenticate(name, c.req.header('Authorization') ?? '');
    if (!session) return c.json({ error: 'Unauthorized or disconnected device' }, 401);
    return hub.serve(c.req.raw, {
      serverName: `device_${name}`,
      tools: () => hub.tools(name, session),
      call: (tool, args) => hub.call(name, session, tool, args),
    });
  });
  return routes;
}
