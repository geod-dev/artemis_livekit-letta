import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { configureBackgroundPorts } from './assistant/background/service.ts';
import { flushBackgroundStorage } from './assistant/background/store.ts';
import { activeCall, announceUpdate, closeCalls, onCallEnded } from './assistant/calls/state.ts';
import { loadConfig } from './assistant/config';
import { closeEventHub, publish, publishList } from './assistant/conversations/events.ts';
import { startAttachmentCleanup, stopAttachmentCleanup } from './assistant/filesystem/attachment-retention';
import {
  closeLettaServerConnection,
  isLettaServerReady,
  startLettaServerConnection,
} from './assistant/letta/server-adapter.ts';
import { updateLabel } from './assistant/conversations/messages.ts';
import {
  closeAllConversationRuntimes,
  conversationRuntime,
  startRuntimeMaintenance,
} from './assistant/runtime';
import { createAuth } from './auth';

export interface BackendApplication {
  close(): Promise<void>;
}

/** Compose, start and own all process resources for this single backend instance. */
export async function startBackend(): Promise<BackendApplication> {
  const config = loadConfig();
  // Import route modules only after .env loading and validation. This keeps
  // paths and route defaults derived from the resolved application config.
  const [
    { deviceHub },
    { createDeviceRoutes },
    { createDeviceMcpRoutes },
    { startMcp, isMcpReady },
    { conversations },
    { files },
    { letta },
    { mcp },
    { utilities },
    { voice },
  ] = await Promise.all([
    import('./devices/hub'),
    import('./devices/api'),
    import('./devices/mcp'),
    import('./mcp/native-tools'),
    import('./routes/conversations'),
    import('./routes/files'),
    import('./routes/letta-callbacks.ts'),
    import('./routes/mcp'),
    import('./routes/utilities'),
    import('./routes/voice'),
  ]);
  startAttachmentCleanup();
  const app = createAuth(config.auth.password, config.auth.deviceToken);
  // The public liveness/readiness endpoints remain outside the /api auth middleware.
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', (c) => {
    const lettaReady = isLettaServerReady();
    const mcpReady = isMcpReady();
    const ready = lettaReady && mcpReady;
    return c.json(
      { status: ready ? 'ready' : 'starting', dependencies: { letta: lettaReady, mcp: mcpReady } },
      ready ? 200 : 503
    );
  });

  // Background work can be triggered by any request handler. Configure all ports
  // before routes are attached or the listener can accept work.
  configureBackgroundPorts({
    isCallActive: (id) => activeCall(id) !== null,
    announceUpdate,
    onCallEnded,
    runUpdate: (id, request) => conversationRuntime(id).run(request),
    publish,
    publishList,
    updateLabel,
  });

  app.route('/internal/mcp/devices', createDeviceMcpRoutes(deviceHub));
  app.route('/api/devices', createDeviceRoutes(deviceHub, config.workspace.dir));
  app.route('/api/conversations', conversations);
  app.route('/api/voice', voice);
  app.route('/api/letta', letta);
  app.route('/api/mcp', mcp);
  app.route('/api', files);
  app.route('/api', utilities);

  deviceHub.start();
  startRuntimeMaintenance();
  const stopMcp = startMcp();
  startLettaServerConnection();
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
      await stopMcp();
      closeLettaServerConnection();
      deviceHub.close();
      await stopAttachmentCleanup();
      closeCalls();
      await closeAllConversationRuntimes();
      await flushBackgroundStorage();
      closeEventHub();
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
