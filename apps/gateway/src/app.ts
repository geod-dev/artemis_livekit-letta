import type { Hono } from 'hono';
import { createAuth } from './auth';
import type { GatewayDependencies } from './compose';
import { createDeviceRoutes } from './devices/api';
import { createDeviceMcpRoutes } from './devices/mcp-endpoint';
import { errorResponse } from './http';
import { createAttachmentRoutes } from './routes/attachments';
import { createConversationRoutes } from './routes/conversations';
import { createLinkPreviewRoutes } from './routes/link-previews';
import { createMcpRoutes } from './routes/mcp-settings';
import { createTranscriptionRoutes } from './routes/transcription';
import { createVoiceRoutes } from './routes/voice';
import { createWorkspaceFileRoutes } from './routes/workspace-files';

/**
 * The gateway's HTTP application from its dependencies. Public liveness and
 * readiness endpoints sit outside the /api authentication middleware.
 */
export function createGatewayApp(deps: GatewayDependencies): Hono {
  const { config, agentServer, attachments, workspace, deviceHub, voiceTokens, transcriber, linkPreview } = deps;
  const app = createAuth(config.auth.password, config.auth.deviceToken, config.voiceGatewayToken);
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
