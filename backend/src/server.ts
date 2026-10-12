import { serve } from '@hono/node-server';
import { config } from './assistant/config';
import { startLettaServerConnection } from './assistant/letta-server';
import { createAuth } from './auth';
import { deviceMcp } from './device-mcp';
import { devices } from './devices';
import { startMcp } from './mcp/native-tools';
import { conversations } from './routes/conversations';
import { files } from './routes/files';
import { letta } from './routes/letta';
import { mcp } from './routes/mcp';
import { utilities } from './routes/utilities';
import { voice } from './routes/voice';

/**
 * The backend: the single entry point to Letta for the chat frontend, the voice
 * agent and the Letta server's notifications mod. All routes live under /api.
 */
const app = createAuth(process.env.ARTEMIS_PASSWORD ?? '', process.env.ARTEMIS_DEVICE_TOKEN ?? '');
app.route('/internal/mcp/devices', deviceMcp);
app.route('/api/devices', devices);
app.route('/api/conversations', conversations);
app.route('/api/voice', voice);
app.route('/api/letta', letta);
app.route('/api/mcp', mcp);
app.route('/api', files);
app.route('/api', utilities);

serve({ fetch: app.fetch, hostname: '0.0.0.0', port: config.port }, ({ port }) => {
  console.info(`[backend] listening on port ${port}`);
});

// Management connection to the Letta server: the shared MCP list, its skill and the bridge mod.
startMcp();
startLettaServerConnection();
