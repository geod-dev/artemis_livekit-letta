import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createGatewayApp } from './app';
import { composeGateway } from './compose';
import { loadConfig } from './config';

export interface GatewayApplication {
  close(): Promise<void>;
}

/** The agent-server reports devices again this often, so a restarted instance learns them too. */
const DEVICE_SYNC_EVERY_MS = 30_000;

/** Compose, start and own all process resources of the gateway. */
export async function startGateway(): Promise<GatewayApplication> {
  const config = loadConfig();
  const deps = composeGateway(config);
  const { agentServer, attachments, deviceHub } = deps;
  attachments.registry.startCleanup();
  const app = createGatewayApp(deps);

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

  deviceHub.start();
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, ({ port }) => {
    console.info(`[gateway] listening on port ${port}`);
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
      await attachments.registry.stopCleanup();
    })();
    return closing;
  };
  // One shutdown path for both signals: close the server, then exit.
  const shutdown = () => void close().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return {
    close: async () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      await close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startGateway();
}
