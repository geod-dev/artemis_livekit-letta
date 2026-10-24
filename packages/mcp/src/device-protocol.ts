/**
 * The shapes a connected device speaks in, free of any SDK. The gateway depends on
 * this module; the SDK-backed server and validators in `vendor/sdk/device-server.ts`
 * are injected into it by the gateway's composition root.
 */

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
