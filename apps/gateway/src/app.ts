import { type Context, Hono } from 'hono';
import { createSessionAuth } from './auth.ts';
import type { GatewayDependencies } from './compose.ts';
import { createDeviceRoutes } from './devices/api.ts';
import { createDeviceMcpRoutes } from './devices/mcp-endpoint.ts';
import { errorResponse } from './http.ts';
import { createAttachmentRoutes } from './routes/attachments.ts';
import { createConversationRoutes } from './routes/conversations.ts';
import { createLinkPreviewRoutes } from './routes/link-previews.ts';
import { createMcpRoutes } from './routes/mcp-settings.ts';
import { createTranscriptionRoutes } from './routes/transcription.ts';
import { createVoiceRoutes } from './routes/voice.ts';
import { createWorkspaceFileRoutes } from './routes/workspace-files.ts';

export interface GatewayAppOptions {
  /** The socket address of a request; the Node server supplies it (see server.ts). */
  peerAddress?: (c: Context) => string | undefined;
}

/**
 * The gateway's HTTP application from its dependencies. Public liveness and
 * readiness endpoints sit outside the /api authentication middleware.
 */
export function createGatewayApp(deps: GatewayDependencies, options: GatewayAppOptions = {}): Hono {
  const {
    config,
    agentServer,
    attachments,
    workspace,
    deviceHub,
    voiceTokens,
    transcriber,
    linkPreview,
  } = deps;
  const app = createSessionAuth({
    password: config.auth.password,
    deviceToken: config.auth.deviceToken,
    dataDir: config.workspace.dataDir,
    peerAddress: options.peerAddress,
  });
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', async (c) => {
    try {
      return await agentServer.relay(c.req.raw, '/ready');
    } catch (error) {
      return errorResponse(error, 503);
    }
  });

  app.route('/internal/mcp/devices', createDeviceMcpRoutes(deviceHub));
  app.route('/api/devices', createDeviceRoutes(deviceHub, workspace));
  app.route('/api/conversations', createConversationRoutes(agentServer, attachments));
  app.route(
    '/api/voice',
    createVoiceRoutes({ agentServer, voiceTokens, voiceGatewayToken: config.voiceGatewayToken })
  );
  app.route('/api/mcp', createMcpRoutes(agentServer));
  app.route('/api', createAttachmentRoutes(attachments));
  app.route('/api', createWorkspaceFileRoutes(workspace));
  app.route('/api', createTranscriptionRoutes({ transcriber }));
  app.route('/api', createLinkPreviewRoutes({ linkPreview }));
  return app;
}
