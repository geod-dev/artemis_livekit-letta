# Artemis device bridge

Python 3.10+; no packages to install. Run on the desktop whose browser, files, audio, terminal, or screen you want to expose.

```sh
python devices/artemis-device.py laptop
# Or choose scopes explicitly without the menu:
python devices/artemis-device.py laptop --scopes browser
```

The script reads **ARTEMIS_DEVICE_TOKEN** from the environment, then from the project `.env`; it asks you to paste the token only if neither contains it. Use `--env-file .env` to explicitly select a token file and override a stale environment variable. Use the VPS device token; the website password is a different credential. The script prints the credential source, its length and a short SHA-256 fingerprint, never the token itself. Surrounding whitespace, quotes, a copied `ARTEMIS_DEVICE_TOKEN=` prefix and terminal paste markers are handled automatically. Use `--server https://your-server` and `--firefox /path/to/firefox` if needed. On Windows, `py` can replace `python`.

## Built-in scopes

Pass one or more scope names after `--scopes`. Only those scopes are registered with Artemis. If `--scopes` is omitted, an interactive keyboard menu opens before the client starts: use Up/Down to move, Space to toggle a scope, and Enter to confirm. Browser is selected by default; the other scopes start unchecked. If you select terminal, the menu asks which executable names to allow. Ctrl+C cancels the menu or cleanly disconnects a running client. A non-interactive launch must provide `--scopes` explicitly.

```sh
python devices/artemis-device.py laptop --scopes browser media filesystem screenshot
python devices/artemis-device.py laptop --scopes filesystem --filesystem-root ~/Documents
python devices/artemis-device.py laptop --scopes terminal --filesystem-root ~/Projects --terminal-command git --terminal-command rg
```

- `browser` exposes `open_url`, which accepts only HTTP and HTTPS URLs. It opens Firefox when available (or the configured `--firefox`), otherwise the system's default URL handler.
- `media` exposes `media_control` for play, pause, current track/status, and volume. Linux uses `playerctl`; macOS uses the Music app via `osascript`; Windows uses system media controls and Windows Core Audio for volume. Linux requires `playerctl` on PATH.
- `filesystem` exposes `filesystem_list`, `filesystem_read`, and `filesystem_write`. Every path is confined to `--filesystem-root` directories; repeat the option for additional roots. If omitted, the current working directory is the root. Reads and writes are limited to UTF-8 text files up to 1 MB; parent directories must already exist.
- `terminal` exposes `terminal_run`. It requires one or more `--terminal-command` entries, each naming an executable already on PATH. Calls use an argument array without a shell, are limited to 30 seconds and 64 arguments, and run only inside the filesystem roots. Output is capped at 64 KB per stream. Only allow commands and arguments you are comfortable letting remote requests invoke; do not allowlist shells or general-purpose interpreters such as `sh`, `cmd`, `powershell`, `python`, or `node`.
- `screenshot` exposes `screenshot_capture` for the primary desktop. Windows uses PowerShell, macOS uses `screencapture`, and Linux requires `gnome-screenshot` or `scrot`. PNG results are limited to 10 MB.

These scopes can read or change local state, control media, run allowlisted processes, or capture the screen. Enable only the scopes needed for the session and keep the device token private.

Keep the script running. Ask Artemis to use a tool on the connected device; it discovers the selected tools through the existing MCP tools and invokes them through `mcp_call_write`.

Each connected device becomes its own standard Streamable HTTP MCP server (`device_laptop`) in the same persistent registry as manually configured servers. The internal endpoint is reachable by the backend and Letta, including workers, using their normal MCP clients. Settings → MCP servers shows the device name, tool count, connection status and an “External device” label. Devices cannot be edited or removed from the settings screen; saving manual servers preserves them. The settings list refreshes automatically every five seconds while open.

Each device needs a unique name. A new connection with the same name replaces the old session. The client keeps an outbound HTTPS event connection open and acknowledges heartbeats. Closing that connection or stopping the script removes its MCP server. If the network disappears without a clean close, the server removes the device within 80 seconds of its last heartbeat. A backend restart removes stale device registrations; clients reconnect automatically. Calls time out after 60 seconds and are never automatically replayed. Older polling clients remain compatible with the heartbeat timeout, but update the script for immediate disconnect handling.

To expose a local MCP stdio server instead of built-in scopes:

```sh
python devices/artemis-device.py laptop --mcp-command python my_mcp_server.py
```

The command option must come last and cannot be combined with `--scopes`. The relay initializes the MCP server, lists its tools (including pagination), and forwards `tools/call` and results. It supports tools only, not resources, prompts, sampling or elicitation. Restart the script when the tool list changes.

The device connection uses authenticated HTTPS events and MCP JSON-RPC tool messages. Internally, each device has a separate authenticated standard MCP endpoint; these endpoints are blocked at the public proxy, and their credentials are omitted from the settings API. No inbound device port, tunnel or browser certificate exception is needed. TLS certificates are verified. Treat the device token as a secret: it lets a device register tools and impersonate another device name, but cannot read chats or log in to the app. Rotate it in `.env` and recreate the backend to revoke all devices. `MCP_DEVICE_BASE_URL` is set to `http://backend:3000` by Compose; for a backend running on the host, set it to an address reachable by both the backend and the Letta container, such as `http://host.docker.internal:3000`.

The browser password is `ARTEMIS_PASSWORD`. Sessions last 90 days, use a signed HttpOnly SameSite cookie, and are invalidated when the password changes and the backend restarts. All API routes require authentication; voice and Letta use their existing separate server credentials, limited to their own routes. Log out from the app menu.
