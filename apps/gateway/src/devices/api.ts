import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { config } from '../assistant/config';
import { saveDeviceFile } from './files';
import { DeviceHub, deviceHub } from './hub';

export function createDeviceRoutes(hub: DeviceHub, workspace = config.workspace.dir): Hono {
  const routes = new Hono();
  routes.post('/register', bodyLimit({ maxSize: 256_000 }), async (c) => {
    try {
      const body = await c.req.json();
      return c.json({ session: await hub.register(body.name, body.tools) });
    } catch (e) {
      return c.json({ error: String(e) }, 400);
    }
  });
  const sessionOf = (c: { req: { header: (name: string) => string | undefined } }) =>
    c.req.header('X-Device-Session') ?? '';
  routes.post('/:name/files/:id', async (c) => {
    const name = c.req.param('name'),
      session = sessionOf(c),
      id = c.req.param('id');
    try {
      const sourcePath = hub.beginFileUpload(name, session, id);
      return c.json(
        await saveDeviceFile(c.req.raw, sourcePath, workspace, () =>
          hub.checkFileUpload(name, session, id)
        )
      );
    } catch (error) {
      return c.json({ error: String(error) }, 409);
    }
  });
  routes.get('/:name/events', (c) => {
    const name = c.req.param('name'),
      session = sessionOf(c);
    try {
      hub.openStream(name, session);
    } catch (e) {
      return c.json({ error: String(e) }, 409);
    }
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => {
        controller.abort();
        void hub
          .unregister(name, session)
          .catch((error) => console.error('[devices] disconnect cleanup failed', error));
      });
      try {
        await stream.writeSSE({ event: 'connected', data: JSON.stringify({ name }) });
        while (!controller.signal.aborted) {
          const requests = await hub.poll(name, session, controller.signal, false);
          for (const request of requests)
            await stream.writeSSE({ event: 'request', data: JSON.stringify(request) });
          if (!controller.signal.aborted) await stream.writeSSE({ event: 'ping', data: '{}' });
        }
      } catch {
        /* A closed or expired connection leaves the shared registry. */
      } finally {
        await hub
          .unregister(name, session)
          .catch((error) => console.error('[devices] disconnect cleanup failed', error));
      }
    });
  });
  // Older client scripts continue to work with a bounded heartbeat lease.
  routes.get('/:name/poll', async (c) => {
    try {
      return c.json({
        requests: await hub.poll(c.req.param('name'), sessionOf(c), c.req.raw.signal),
      });
    } catch (e) {
      return c.json({ error: String(e) }, 409);
    }
  });
  routes.post('/:name/heartbeat', (c) => {
    try {
      hub.heartbeat(c.req.param('name'), sessionOf(c));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 409);
    }
  });
  routes.post('/:name/disconnect', async (c) => {
    try {
      await hub.unregister(c.req.param('name'), sessionOf(c));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 503);
    }
  });
  // A 10 MB screenshot is about 13.4 MB when base64 encoded in JSON.
  routes.post('/:name/results', bodyLimit({ maxSize: 16_000_000 }), async (c) => {
    try {
      const body = await c.req.json();
      hub.result(
        c.req.param('name'),
        sessionOf(c),
        body.id,
        body.error
          ? { isError: true, content: [{ type: 'text', text: JSON.stringify(body.error) }] }
          : body.result
      );
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: String(e) }, 409);
    }
  });
  return routes;
}
export const devices = createDeviceRoutes(deviceHub);
