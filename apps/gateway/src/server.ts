import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createGatewayApp } from './app';
import { composeGateway } from './compose';
import { loadConfig } from './config';
import { DeviceSync } from './devices/sync';

export interface GatewayApplication {
  close(): Promise<void>;
}

/** Compose, start and own all process resources of the gateway. */
export async function startGateway(): Promise<GatewayApplication> {
  const config = loadConfig();
  const deps = composeGateway(config);
  const { agentServer, attachments, deviceHub } = deps;
  attachments.registry.startCleanup();
  const app = createGatewayApp(deps);

  const deviceSync = new DeviceSync({ devices: deviceHub, agent: agentServer });
  deviceSync.start();
  deviceHub.start();
  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    ({ port }) => {
      console.info(`[gateway] listening on port ${port}`);
    }
  ) as Server;
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
      deviceSync.stop();
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
