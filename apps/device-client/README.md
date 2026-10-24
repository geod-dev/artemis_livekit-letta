# Artemis device bridge

The device client (`apps/device-client`) is a Python script that runs on the desktop it
exposes. It talks to the gateway, and the agent server reaches the device through the
gateway's device MCP endpoints. Check group: `pnpm check:device-client`.

Python 3.13 or newer (`requires-python` in `pyproject.toml`; the repository's Python pin is `apps/voice-agent/.python-version`). No packages to install: the client uses only the standard library, so it has no python-dotenv dependency and reads `.env` with its own small parser. Run on the desktop whose browser, files, audio, terminal, or screen you want to expose.

```sh
python apps/device-client/artemis-device.py laptop
# Or choose scopes explicitly without the menu:
python apps/device-client/artemis-device.py laptop --scopes browser
```

The script reads **ARTEMIS_DEVICE_TOKEN** in this order: the environment, then the repository-root `.env`, then `apps/device-client/.env`. The lookup does not depend on the directory you launch from. It asks you to paste the token only if none of these contains it. Use `--env-file PATH` to select a token file explicitly and override a stale environment variable. Use the VPS device token; the website password is a different credential. The script prints the credential source and its length. Add `--verbose-auth` to also print the last four characters of the token, which helps match a 401 to the token in use; the full token is never printed. Surrounding whitespace, quotes, a copied `ARTEMIS_DEVICE_TOKEN=` prefix and terminal paste markers are handled automatically.

Without `--server`, the client connects to `ARTEMIS_URL` if set, otherwise to `http://IP_ADDRESS:3000`. `ARTEMIS_URL` and `IP_ADDRESS` are each read from the environment first, then the repository-root `.env` (`IP_ADDRESS` defaults to `127.0.0.1`), the same way voice-agent resolves `IP_ADDRESS`. Plain HTTP is accepted only for exactly `localhost` and `127.0.0.1`; any other host, including `[::1]` and a LAN address, must be named with `--server https://your-server`. Use `--firefox /path/to/firefox` if needed. On Windows, `py` can replace `python`.

Divergence from voice-agent: both refuse plain HTTP to a remote host, but voice-agent also allows loopback IPv6 (`[::1]`) and single-label Compose service names (`http://gateway:3000`), while the device client allows only the two exact names above.

## Built-in scopes

Pass one or more scope names after `--scopes`. Only those scopes are registered with Artemis. If `--scopes` is omitted, an interactive keyboard menu opens before the client starts: use Up/Down to move, Space to toggle a scope, and Enter to confirm. Browser is selected by default; the other scopes start unchecked. Ctrl+C cancels the menu or cleanly disconnects a running client. A non-interactive launch must provide `--scopes` explicitly.

```sh
python apps/device-client/artemis-device.py laptop --scopes browser media filesystem screenshot
python apps/device-client/artemis-device.py laptop --scopes filesystem --active-folder ~/Documents
python apps/device-client/artemis-device.py laptop --scopes terminal --active-folder ~/Projects
```

The launcher `artemis-device.py` is the one documented entry point. The `artemis_device` package can also be run as `python -m artemis_device`. Run the tests from `apps/device-client` with `uv run --python 3.13 --no-project python -m unittest discover -s tests -p "test_*.py"` (uv is required for this command; the Python version is pinned as above).

- `browser` exposes `open_url`, which accepts only HTTP and HTTPS URLs. It opens Firefox when available (or the configured `--firefox`), otherwise the system's default URL handler.
- `media` exposes `media_control` for play, pause, current track/status, and volume. Linux uses `playerctl`; macOS uses the Music app via `osascript`; Windows uses system media controls and Windows Core Audio for volume. Linux requires `playerctl` on PATH.
- `filesystem` exposes `filesystem_list`, `filesystem_read`, and `filesystem_write`. It can access any location on the device; every tool call must supply an absolute path. `--active-folder` adds context to the tool descriptions but does not limit access. Reads and writes are limited to UTF-8 text files up to 1 MB; parent directories must already exist. Each read, write and export is logged to stderr as an `[audit]` line that names the path, never the file contents.
  It also exposes `filesystem_export`: copy any local file up to 25 MB, including PDFs, images and Office documents, directly into the agent workspace using an authenticated HTTPS binary upload. Only the workspace path, size, SHA-256 checksum and download link enter the tool result; file bytes and base64 never enter the model context. The source is left in place. Each copy gets a unique path under `/workspace/data/device-files/`; the agent can share the returned link in chat. Uploads are accepted only for that connected device's pending export call, and incomplete uploads are discarded. Restart the updated client with the `filesystem` scope to register this tool; the gateway must also run the updated code.
- `terminal` exposes `terminal_run` with system-wide access under the client account's OS permissions. Send a full command line in `command` with `arguments` omitted or empty to run through PowerShell on Windows (cmd fallback), or `/bin/sh` on Linux/macOS; spaces, quotes, pipes and redirection are supported. Use the device's shell syntax (Linux `ls -la` flags are not PowerShell flags). For direct execution without shell interpretation, send only the executable name/path in `command` and a non-empty `arguments` list. An existing executable path is also executed directly even if it contains spaces. The optional `cwd` must be an absolute path and can be anywhere; it defaults to `--active-folder`. Calls are limited to 30 seconds and output to 64 KB per stream; on timeout the process tree is terminated. Each call is logged to stderr as an `[audit]` line with its command and working directory.
- `screenshot` exposes `screenshot_capture` for the primary desktop. Windows uses PowerShell, macOS uses `screencapture`, and Linux requires `gnome-screenshot` or `scrot`. PNG results are limited to 10 MB. The capture is returned inline as a PNG image in the tool result; nothing is saved to the agent workspace.

`--active-folder` defaults to the directory where the client is launched. It describes the user's current context in filesystem and terminal tools; all absolute paths on the device remain accessible. Filesystem and terminal can read or change local state anywhere on the device, media controls audio, and screenshot captures the screen. Enable only the scopes needed for the session and keep the device token private.

**Threat model.** The client trusts the gateway it connects to and the operator who launches it. Anyone who holds the device token, or can make the gateway send calls, can run terminal commands and read or write any file that the client's OS account can access, with no folder sandbox. The `terminal` and `filesystem` scopes are therefore intentional full-device access, not a restricted mode: the protection is the scope opt-in, the token secrecy and the audit trail. Audit lines go to stderr on the device (`[audit] <tool> ...`) so the operator can see each terminal command and file path as it runs. Transport is HTTPS with certificate verification; the client does not accept a plain-HTTP remote server. A tool result never contains a file's bytes except the text returned by `filesystem_read` and the inline screenshot image.

Keep the script running. Ask Artemis to use a tool on the connected device; it discovers the selected tools through the existing MCP tools and invokes them through `mcp_call_write`.

Each connected device becomes its own standard Streamable HTTP MCP server (`device_laptop`) in the same persistent registry as manually configured servers. The internal endpoint is reachable by the agent-server, including its workers, using their normal MCP clients. Settings → MCP servers shows the device name, tool count, connection status and an “External device” label. Devices cannot be edited or removed from the settings screen; saving manual servers preserves them. The settings list refreshes automatically every five seconds while open.

Each device needs a unique name. A registration with a name that a live connection already holds is refused with HTTP 409; the client reports it and retries with backoff, so stop the other client or choose another name. If the gateway ends this client's registration (HTTP 410, its session expired), the client registers again. The client keeps an outbound HTTPS event connection open and acknowledges heartbeats. Closing that connection or stopping the script removes its MCP server. If the network disappears without a clean close, the server removes the device within 75 seconds of its last heartbeat. A gateway restart removes stale device registrations; clients reconnect automatically. Calls time out after 60 seconds and are never automatically replayed. Older polling clients remain compatible with the heartbeat timeout, but update the script for immediate disconnect handling.

To expose a local MCP stdio server instead of built-in scopes:

```sh
python apps/device-client/artemis-device.py laptop --mcp-command python my_mcp_server.py
```

The command option must come last and cannot be combined with `--scopes`. The relay initializes the MCP server, lists its tools (including pagination), and forwards `tools/call` and results. It supports tools only, not resources, prompts, sampling or elicitation; a server request the relay does not implement receives JSON-RPC error `-32001`. Restart the script when the tool list changes.

The device connection uses authenticated HTTPS events and MCP JSON-RPC tool messages. Internally, each device has a separate authenticated standard MCP endpoint; these endpoints are blocked at the public proxy, and their credentials are omitted from the settings API. No inbound device port, tunnel or browser certificate exception is needed. TLS certificates are verified. Treat the device token as a secret: it lets a device register tools and impersonate another device name, but cannot read chats or log in to the app. Rotate it in `.env` and recreate the gateway to revoke all devices. `MCP_DEVICE_BASE_URL` is set to `http://gateway:3000` by Compose; for a gateway running on the host, set it to an address reachable by the agent-server, such as `http://host.docker.internal:3000`.

The browser password is `ARTEMIS_PASSWORD`. Sessions last 90 days, use a signed HttpOnly SameSite cookie, and are invalidated when the password changes and the gateway restarts. All API routes require authentication; voice and the agent-server use their existing separate server credentials, limited to their own routes. Log out from the app menu.
