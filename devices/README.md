# Artemis device bridge

Python 3.10+; no packages to install. Run on your desktop in a graphical session with Firefox installed.

```sh
python devices/artemis-device.py laptop
```

Enter the **ARTEMIS_DEVICE_TOKEN** from the VPS `.env` when prompted. Alternatively set it in the environment (avoid passing secrets on the command line). Use `--server https://your-server` and `--firefox /path/to/firefox` if needed. On Windows, `py` can replace `python`.

Keep the script running. Ask Artemis to open a URL in Firefox on `laptop`: it discovers `mcp__device_laptop__open_url` through the existing MCP tools and invokes it through `mcp_call_write`.

Each connected device becomes its own standard Streamable HTTP MCP server (`device_laptop`) in the same persistent registry as manually configured servers. The internal endpoint is reachable by the backend and Letta, including workers, using their normal MCP clients. Settings → MCP servers shows the device name, tool count, connection status and an “External device” label. Devices cannot be edited or removed from the settings screen; saving manual servers preserves them. The settings list refreshes automatically every five seconds while open.

Each device needs a unique name. A new connection with the same name replaces the old session. The client keeps an outbound HTTPS event connection open and acknowledges heartbeats. Closing that connection or stopping the script removes its MCP server. If the network disappears without a clean close, the server removes the device within 80 seconds of its last heartbeat. A backend restart removes stale device registrations; clients reconnect automatically. Calls time out after 60 seconds and are never automatically replayed. Older polling clients remain compatible with the heartbeat timeout, but update the script for immediate disconnect handling.

To expose other tools, relay any local MCP stdio server instead of the built-in Firefox tool:

```sh
python devices/artemis-device.py laptop --mcp-command python my_mcp_server.py
```

The command option must come last. The relay initializes the MCP server, lists its tools (including pagination), and forwards `tools/call` and results. It supports tools only, not resources, prompts, sampling or elicitation. Restart the script when the tool list changes.

The device connection uses authenticated HTTPS events and MCP JSON-RPC tool messages. Internally, each device has a separate authenticated standard MCP endpoint; these endpoints are blocked at the public proxy, and their credentials are omitted from the settings API. No inbound device port, tunnel or browser certificate exception is needed. TLS certificates are verified. Treat the device token as a secret: it lets a device register tools and impersonate another device name, but cannot read chats or log in to the app. Rotate it in `.env` and recreate the backend to revoke all devices. `MCP_DEVICE_BASE_URL` is set to `http://backend:3000` by Compose; for a backend running on the host, set it to an address reachable by both the backend and the Letta container, such as `http://host.docker.internal:3000`.

The browser password is `ARTEMIS_PASSWORD`. Sessions last 90 days, use a signed HttpOnly SameSite cookie, and are invalidated when the password changes and the backend restarts. All API routes require authentication; voice and Letta use their existing separate server credentials, limited to their own routes. Log out from the app menu.
