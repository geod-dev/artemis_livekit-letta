# @artemis/mcp

MCP server settings, the client, the catalog, the registry, and the `mcp_describe`, `mcp_call` and `mcp_call_write` bridge tools.

- **Entry point:** `src/index.ts` exports `McpClient`, `McpCatalog`, `McpServerRegistry`, the bridge tools, the reminder text, and the settings helpers.
- **Subpaths:**
  - `./device-protocol` (`src/device-protocol.ts`): device types, free of the SDK. Safe to import anywhere.
  - `./device-server` (`src/vendor/sdk/device-server.ts`): the vendor MCP endpoint for a connected device. Composition roots only.
  - `./sdk` (`src/vendor/sdk/index.ts`): the vendor MCP client. Composition roots only.
- **Depends on:** `@artemis/core`, `@artemis/contracts`, `@artemis/tools`, `@artemis/workspace`, `@modelcontextprotocol/sdk`.
- **Check:** `pnpm check:packages`.
