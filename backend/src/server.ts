import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { AgentServerClient } from './agent-server/client';
import { loadConfig } from './assistant/config';
import { startAttachmentCleanup, stopAttachmentCleanup } from './assistant/filesystem/attachment-retention';
import { createAuth } from './auth';
import { errorResponse } from './http';

export interface BackendApplication {
  close(): Promise<void>;
}

/** The agent-server reports devices again this often, so a restarted instance learns them too. */
const DEVICE_SYNC_EVERY_MS = 30_000;

/** Compose, start and own all process resources of the gateway. */
export async function startBackend(): Promise<BackendApplication> {
  const config = loadConfig();
  // Import route modules only after .env loading and validation. This keeps
  // paths and route defaults derived from the resolved application config.
  const [
    { deviceHub },
    { createDeviceRoutes },
    { createDeviceMcpRoutes },
    { createConversationRoutes },
    { createMcpRoutes },
    { createVoiceRoutes },
    { files },
    { utilities },
  ] = await Promise.all([
    import('./devices/hub'),
    import('./devices/api'),
    import('./devices/mcp'),
    import('./routes/conversations'),
    import('./routes/mcp'),
    import('./routes/voice'),
    import('./routes/files'),
    import('./routes/utilities'),
  ]);
  const agentServer = new AgentServerClient(config.agentServer);
  startAttachmentCleanup();
  const app = createAuth(config.auth.password, config.auth.deviceToken);
  // The public liveness/readiness endpoints remain outside the /api auth middleware.
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', async (c) => {
    try {
      return await agentServer.relay(c.req.raw, '/ready');
    } catch (error) {
      return errorResponse(error, 503);
    }
  });

  // Each sync sends the full device list, one at a time, so the last request
  // always carries the current list. Device changes retry through the hub.
  let deviceSync: Promise<void> = Promise.resolve();
  const syncDevices = () => {
    deviceSync = deviceSync.catch(() => {}).then(() => agentServer.setManagedMcp(deviceHub.servers()));
    return deviceSync;
  };
  deviceHub.onChange(syncDevices);
  const reportDevices = () =>
    syncDevices().catch((error) => console.error('[devices] could not sync devices to the agent-server', error));
  void reportDevices();
  const deviceSyncTimer = setInterval(() => void reportDevices(), DEVICE_SYNC_EVERY_MS);
  deviceSyncTimer.unref();

  app.route('/internal/mcp/devices', createDeviceMcpRoutes(deviceHub));
  app.route('/api/devices', createDeviceRoutes(deviceHub, config.workspace.dir));
  app.route('/api/conversations', createConversationRoutes(agentServer));
  app.route('/api/voice', createVoiceRoutes(agentServer));
  app.route('/api/mcp', createMcpRoutes(agentServer));
  app.route('/api', files);
  app.route('/api', utilities);

  deviceHub.start();
  const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port: config.port }, ({ port }) => {
    console.info(`[backend] listening on port ${port}`);
  }) as Server;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => server.closeAllConnections(), 1_000).unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      clearInterval(deviceSyncTimer);
      deviceHub.close();
      await stopAttachmentCleanup();
    })();
    return closing;
  };
  const onSigint = () => void close().then(() => process.exit(0));
  const onSigterm = () => void close().then(() => process.exit(0));
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return {
    close: async () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      await close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startBackend();
}
