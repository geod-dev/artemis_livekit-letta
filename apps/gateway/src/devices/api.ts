import type { WorkspaceTransport } from '@artemis/workspace';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { MAX_UPLOAD_BYTES } from '../attachments/attachment-policy';
import { HttpError, errorResponse, jsonObject, requestLimit } from '../http';
import { saveDeviceFile } from './files';
import type { DeviceHub } from './hub';

const REGISTER_BODY_LIMIT = 256_000;
/** A 10 MB screenshot is about 13.4 MB when base64 encoded in JSON. */
const RESULT_BODY_LIMIT = 16_000_000;
const NOT_A_JSON_OBJECT = 'Request body must be a JSON object';

/** A file upload declares its size, which is checked before any byte is stored. */
function checkDeclaredSize(request: Request): void {
  const declared = request.headers.get('Content-Length');
  if (declared === null || !/^\d+$/.test(declared))
    throw new HttpError('Upload requires a Content-Length header', 400);
  if (Number(declared) > MAX_UPLOAD_BYTES)
    throw new HttpError(
      `File is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit`,
      413
    );
}

/**
 * The HTTP API a device client uses: registration, its event stream, requests and results.
 * Client-facing failures are HttpErrors from the hub; anything else is a masked 500.
 */
export function createDeviceRoutes(hub: DeviceHub, workspace: WorkspaceTransport): Hono {
  const routes = new Hono();
  routes.post('/register', requestLimit(REGISTER_BODY_LIMIT), async (c) => {
    const body = await jsonObject(c.req.raw, REGISTER_BODY_LIMIT);
    if (!body) return errorResponse(NOT_A_JSON_OBJECT, 400);
    try {
      return c.json({ session: await hub.register(body.name, body.tools) });
    } catch (error) {
      return errorResponse(error);
    }
  });
  const sessionOf = (c: { req: { header: (name: string) => string | undefined } }) =>
    c.req.header('X-Device-Session') ?? '';
  routes.post('/:name/files/:id', async (c) => {
    const name = c.req.param('name'),
      session = sessionOf(c),
      id = c.req.param('id');
    try {
      checkDeclaredSize(c.req.raw);
      const sourcePath = hub.beginFileUpload(name, session, id);
      return c.json(
        await saveDeviceFile(workspace, c.req.raw, sourcePath, () =>
          hub.checkFileUpload(name, session, id)
        )
      );
    } catch (error) {
      return errorResponse(error);
    }
  });
  routes.get('/:name/events', (c) => {
    const name = c.req.param('name'),
      session = sessionOf(c);
    try {
      hub.openStream(name, session);
    } catch (error) {
      return errorResponse(error);
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
  // A poll returns the pending requests as they arrive, and renews the device's lease like a heartbeat.
  routes.get('/:name/poll', async (c) => {
    try {
      return c.json({
        requests: await hub.poll(c.req.param('name'), sessionOf(c), c.req.raw.signal),
      });
    } catch (error) {
      return errorResponse(error);
    }
  });
  routes.post('/:name/heartbeat', (c) => {
    try {
      hub.heartbeat(c.req.param('name'), sessionOf(c));
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  });
  routes.post('/:name/disconnect', async (c) => {
    try {
      await hub.unregister(c.req.param('name'), sessionOf(c));
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(error, 503);
    }
  });
  routes.post('/:name/results', requestLimit(RESULT_BODY_LIMIT), async (c) => {
    const body = await jsonObject(c.req.raw, RESULT_BODY_LIMIT);
    if (!body) return errorResponse(NOT_A_JSON_OBJECT, 400);
    try {
      hub.result(
        c.req.param('name'),
        sessionOf(c),
        String(body.id),
        body.error
          ? { isError: true, content: [{ type: 'text', text: JSON.stringify(body.error) }] }
          : body.result
      );
      return c.json({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  });
  return routes;
}
