import { Hono } from 'hono';
import { isLettaServerReady } from '../assistant/letta-server';
import type { McpSettingsResponse } from '../chat-types';
import { errorResponse } from '../http';
import { getMcpServers, mcpCatalog, setMcpServers } from '../mcp/native-tools';
import { InvalidMcpServersError, type McpServer, validateMcpServers } from '../mcp/settings';

/**
 * Settings -> MCP servers: one shared list for every agent, in a settings file
 * only the backend writes and only `letta mcp` (run from agent shells with
 * HOME pointed at it) reads. See `mcp/settings.ts` for why Letta's per-agent
 * settings cannot hold it.
 */
export const mcp = new Hono();

/** Internal credentials and endpoint addresses do not belong in the device UI. */
function publicServers(servers: McpServer[]): McpServer[] {
  return servers.map((server) =>
    server.managed
      ? { name: server.name, transport: server.transport, managed: server.managed }
      : server
  );
}

function bridgeStatus(): McpSettingsResponse['bridge'] {
  const { tools, failures } = mcpCatalog.snapshot();
  return {
    servers: [...new Set(tools.map((tool) => tool.server.name))],
    tools: tools.length,
    failures: Object.fromEntries(failures),
  };
}

mcp.get('/', async () => {
  if (!isLettaServerReady()) return errorResponse('The Letta server is not connected', 503);
  try {
    const body: McpSettingsResponse = {
      servers: publicServers(await getMcpServers()),
      bridge: bridgeStatus(),
    };
    return Response.json(body);
  } catch (error) {
    return errorResponse(error, error instanceof InvalidMcpServersError ? 400 : 502);
  }
});

mcp.put('/', async (c) => {
  if (!isLettaServerReady()) return errorResponse('The Letta server is not connected', 503);
  const body = (await c.req.json().catch(() => null)) as { servers?: unknown } | null;
  let servers: McpServer[];
  try {
    servers = validateMcpServers(body?.servers);
  } catch (error) {
    return errorResponse(error, error instanceof InvalidMcpServersError ? 400 : 500);
  }
  try {
    await setMcpServers(servers);
  } catch (error) {
    return errorResponse(error, error instanceof InvalidMcpServersError ? 400 : 502);
  }
  const response: McpSettingsResponse = {
    servers: publicServers(await getMcpServers()),
    bridge: bridgeStatus(),
  };
  return Response.json(response);
});
