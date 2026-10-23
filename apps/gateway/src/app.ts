import type { Hono } from 'hono';
import { createAuth } from './auth';
import type { GatewayDependencies } from './compose';
import { errorResponse } from './http';
import { createDeviceRoutes } from './devices/api';
import { createDeviceMcpRoutes } from './devices/mcp-endpoint';
import { createConversationRoutes } from './routes/conversations';
import { createFileRoutes } from './routes/files';
import { createMcpRoutes } from './routes/mcp';
import { createVoiceRoutes } from './routes/voice';
import { utilities } from './routes/utilities';

/**
 * The gateway's HTTP application from its dependencies. Public liveness and
 * readiness endpoints sit outside the /api authentication middleware.
 */
export function createGatewayApp(deps: GatewayDependencies): Hono {
  const { config, agentServer, attachments, workspace, deviceHub } = deps;
  const app = createAuth(config.auth.password, config.auth.deviceToken);
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', async (c) => {
    try {
      return await agentServer.relay(c.req.raw, '/ready');
    } catch (error) {
      return errorResponse(error, 503);
    }
  });

  app.route('/internal/mcp/devices', createDeviceMcpRoutes(deviceHub));
  app.route('/api/devices', createDeviceRoutes(deviceHub, config.workspace.dir));
  app.route('/api/conversations', createConversationRoutes(agentServer, attachments));
  app.route('/api/voice', createVoiceRoutes(agentServer));
  app.route('/api/mcp', createMcpRoutes(agentServer));
  app.route('/api', createFileRoutes(attachments, workspace));
  app.route('/api', utilities);
  return app;
}
