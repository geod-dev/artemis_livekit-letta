import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  type CallToolResult,
  CallToolResultSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Server side of a connected device: one standard Streamable HTTP MCP endpoint
 * per device. The gateway authenticates the request and supplies the device's
 * tools and call handler; this module only speaks MCP.
 */

/** Most tools a device may list. */
const MAX_DEVICE_TOOLS = 100;

/** A tool a device exposes (the MCP `Tool` shape, as the gateway uses it). */
export interface DeviceTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; [key: string]: unknown };
  annotations?: Record<string, unknown>;
}

/** The result of a device tool call (the MCP `CallToolResult` shape). */
export interface DeviceToolResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** What one authenticated device request is served from. */
export interface DeviceBinding {
  /** MCP server name reported on `initialize`, e.g. `device_<name>`. */
  serverName: string;
  tools(): DeviceTool[];
  call(tool: string, args: Record<string, unknown>): Promise<DeviceToolResult>;
}

/** Validate a device's `tools` list (at most 100 tools); throws a zod error when invalid. */
export function parseDeviceTools(value: unknown): DeviceTool[] {
  return ToolSchema.array().max(MAX_DEVICE_TOOLS).parse(value) as DeviceTool[];
}

/** Validate a device's tool-call result; throws a zod error when invalid. */
export function parseDeviceToolResult(value: unknown): DeviceToolResult {
  return CallToolResultSchema.parse(value) as DeviceToolResult;
}

/** Serve one MCP request for one device (stateless: no session ids, JSON responses). */
export async function handleDeviceMcpRequest(
  request: Request,
  device: DeviceBinding
): Promise<Response> {
  const server = new Server(
    { name: device.serverName, version: '1' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: device.tools() as Tool[],
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (message) =>
      (await device.call(message.params.name, message.params.arguments ?? {})) as CallToolResult
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
