# Artemis device bridge

Python 3.10+; no packages to install. Run on your desktop in a graphical session with Firefox installed.

```sh
python devices/artemis-device.py laptop
```

Enter the **ARTEMIS_DEVICE_TOKEN** from the VPS `.env` when prompted. Alternatively set it in the environment (avoid passing secrets on the command line). Use `--server https://your-server` and `--firefox /path/to/firefox` if needed. On Windows, `py` can replace `python`.

Keep the script running. Ask Artemis to open a URL in Firefox on `laptop`: it discovers `mcp__device_laptop__open_url` through `mcp_search` and invokes it through `mcp_call_write`. Each device needs a unique name. A new connection with the same name replaces the old session. Devices disappear from discovery after 75 seconds without a poll; calls time out after 60 seconds and are never automatically replayed.

To expose other tools, relay any local MCP stdio server instead of the built-in Firefox tool:

```sh
python devices/artemis-device.py laptop --mcp-command python my_mcp_server.py
```

The command option must come last. The relay initializes the MCP server, lists its tools (including pagination), and forwards `tools/call` and results. It supports tools only, not resources, prompts, sampling or elicitation. Restart the script when the tool list changes.

The backend is an outbound device bridge using authenticated HTTPS long polling and MCP JSON-RPC tool messages; it is not a public standard MCP transport endpoint. No inbound device port, tunnel or browser certificate exception is needed. TLS certificates are verified. Treat the device token as a secret: it lets a device register tools and impersonate another device name, but cannot read chats or log in to the app. Rotate it in `.env` and recreate the backend to revoke all devices.

The browser password is `ARTEMIS_PASSWORD`. Sessions last 90 days, use a signed HttpOnly SameSite cookie, and are invalidated when the password changes and the backend restarts. All API routes require authentication; voice and Letta use their existing separate server credentials, limited to their own routes. Log out from the app menu.
