# Architecture

## Apps

Each directory under `apps/` is a deployable entry point. Apps never import each other.

- **`apps/web`** (`@artemis/web`) is a Vite React single-page app. The production build is
  static files served by nginx (`apps/web/nginx.conf`) on port 8080 in its container. nginx
  sends `/api` and `/health` to the gateway, `/livekit/` to LiveKit, and returns 404 for
  `/internal/`. `/nginx-health` is local liveness for the container healthcheck.
- **`apps/gateway`** (`@artemis/gateway`) is the public HTTP edge, on `GATEWAY_PORT`
  (default 3000). Entry point: `src/server.ts`; composition root: `src/compose.ts`; settings
  and production checks: `src/config.ts`. It checks the browser session (`ARTEMIS_PASSWORD`)
  and device tokens (`ARTEMIS_DEVICE_TOKEN`). Failed logins are limited per client address
  (10 per minute) and across all clients (50 per minute); a lockout doubles on each repeat, up
  to 15 minutes, and a successful login clears the repeats. The gateway serves attachments and
  workspace files, issues LiveKit tokens, hosts the device hub, and proxies conversation, MCP,
  and voice requests, and their SSE streams, to the agent server.
- **`apps/agent-server`** (`@artemis/agent-server`) owns conversations, turns, events,
  background tasks and subagents, tools, the MCP registry, memory retention and recall,
  titles, and call state. Entry point: `src/main.ts`, on `AGENT_SERVER_PORT` (default 4000);
  composition root: `src/compose.ts`. Its `/v1` API requires `AGENT_SERVER_TOKEN`. It runs
  database migrations at startup. Its prompt templates are bundled from
  `apps/agent-server/templates/`.
- **`apps/voice-agent`** is a Python LiveKit worker (package `voice_agent`). It joins rooms,
  runs speech-to-text and text-to-speech, and talks only to the gateway's `/api/voice`
  routes: call state, call updates, and OpenAI-compatible chat completions. See its
  [README](../apps/voice-agent/README.md) for its settings.
- **`apps/device-client`** is a Python script that runs on a desktop and exposes selected
  local capabilities (browser, media, filesystem, terminal, screenshot) to the assistant
  through the gateway. See its [README](../apps/device-client/README.md).
- **`apps/mobile`** is an Android WebView wrapper that loads the HTTPS web app selected at
  build time. It shares no code with the other apps. See its
  [README](../apps/mobile/README.md).

Infrastructure services in the Compose stack, with no code in this repository:
`postgres` (pgvector; databases `artemis` and `hindsight`), `hindsight` (memory service),
and `livekit` (WebRTC signaling and media).

## Packages

Packages under `packages/` are libraries. Each lists its own dependencies in `package.json`,
and each exposes its public surface through `src/index.ts` and named subpath exports.

| Package | Role |
|---|---|
| `@artemis/contracts` | Wire types (`chat-types`, `chat-http`, `agent-server`), tool names and schemas, present-tool validation, and the generated present-tool JSON. The present-tool component names are declared here; the component library itself is in `apps/web`. No runtime dependencies. |
| `@artemis/core` | Shared primitives: clock, content, errors, ids, image types, and logger. Subpath `./testing`. |
| `@artemis/http` | Bearer auth, errors, and SSE client and server helpers. |
| `@artemis/agent-loop` | The turn loop and the one-shot runner. |
| `@artemis/llm` | Model provider interface, router, and stream runner. Vendors: `anthropic`, `openai-compatible`. Subpath `./testing`. |
| `@artemis/memory` | Memory store interface, rendering, and budgeting. Vendor: `hindsight`. Subpath `./testing`. |
| `@artemis/storage` | Persistence contracts, domain types, and repositories, with migrations. Vendor: `postgres`. The in-memory `ephemeral` store is exposed as the `./testing` subpath. |
| `@artemis/mcp` | MCP registry, catalog, bridge, client, settings, and the device screenshot policy. Vendor: `sdk`, which also serves the device MCP endpoint (`./device-server`). |
| `@artemis/tools` | Tool definitions, toolsets, results, and workspace tools (`./workspace-tools`). |
| `@artemis/workspace` | Workspace interface and media types. Vendor: `filesystem`. |
| `@artemis/voice-services` | Voice providers behind ports: the LiveKit token issuer and the Groq transcriber. Vendors: `./groq` and `./livekit`, imported only by the gateway's `compose.ts`. |

## Dependency rules

`scripts/check-boundaries.mjs` enforces these rules. It parses every `.ts`, `.tsx`, `.mts`,
`.cts`, `.mjs`, `.cjs`, `.js`, and `.jsx` file under `apps/`, `packages/`, and `scripts/`,
including declaration files and generated directories. The `scripts/` files are checked as
tooling under rule 10. It runs as the `boundaries` check group, and its
`--self-test` runs one fixture per rule. The Python apps (`apps/voice-agent` and
`apps/device-client`) are outside the checker's scope and have their own tooling.

1. `packages/contracts` imports nothing outside itself and has no runtime dependencies.
2. `packages/*` never import `apps/*`. They reach a vendor path only from inside their own
   `src/vendor`. Relative imports stay inside the package.
3. `apps/*` never import another app, and no relative path leaves their own root.
4. Only `apps/<app>/src/compose.ts` imports a vendor implementation.
5. `apps/web` imports only `@artemis/contracts` among workspace packages. Its `src` imports
   no Node built-in module and no server-only npm SDK.
6. Every bare import is declared in the importing package's `package.json`.
7. The workspace package graph (`workspace:` and `link:` references) is acyclic.
8. A vendor SDK npm package (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`,
   `@vectorize-io/hindsight-client`, `livekit-server-sdk`, `openai`, `pg`) is imported only
   from a `src/vendor` directory and from `apps/<app>/src/compose.ts`.
9. Non-test code imports no `testing` module (a `*/testing` subpath).
10. `scripts/` (tooling) imports only the files named in the checker's `TOOLING_IMPORTS`, a
    package's `src/index.ts`, or a package subpath export.

**Test code is exempt** from rules 4, 8, 9, and the `apps/web/src` half of rule 5. Test code is
any `*.test.*` file and anything under a `test/` or `testing/` directory. Tests build fixtures
from the vendor testing subpaths and from fake servers.

**Reviewed exceptions** live in the `ALLOWLIST` array in the checker. The array is empty, so no
violation is excused. The only importer of `@artemis/mcp/device-server` is the gateway's
`apps/gateway/src/compose.ts`, which rule 4 already allows, so the device MCP endpoint needs no
exception. Add an entry only for a violation that is intended, and give its reason.

## Vendor rule

Third-party implementations live only in `packages/<name>/src/vendor/`, behind the package's
interface: Anthropic and OpenAI-compatible (`llm`), Hindsight (`memory`), Postgres and the
in-memory `ephemeral` store (`storage`), the MCP SDK (`mcp`), and the filesystem
(`workspace`). The composition roots, `apps/agent-server/src/compose.ts` and
`apps/gateway/src/compose.ts`, are the only places that select them. Everything else depends
on the interface.

## Routes

The gateway mounts these routes (`apps/gateway/src/app.ts`). Paths are relative to the
gateway's origin. nginx serves the same paths to browsers; it returns 404 for `/internal/`.

| Path | Methods | Purpose |
|---|---|---|
| `/health`, `/ready` | GET | Liveness. Readiness relays the agent server's `/ready`. Both sit outside `/api` authentication. |
| `/api/auth/session`, `/api/auth/login`, `/api/auth/logout` | GET, POST | Browser session. Login is rate limited. |
| `/api/conversations` | GET, POST | List and create conversations. |
| `/api/conversations/events` | GET | Conversation list events (SSE). |
| `/api/conversations/:id` | GET, PATCH, DELETE | Read, update, or delete one conversation. |
| `/api/conversations/:id/events` | GET | Conversation events (SSE). |
| `/api/conversations/:id/messages` | GET, POST | List messages; send a turn. |
| `/api/conversations/:id/messages/:messageId` | DELETE | Delete a message. |
| `/api/conversations/:id/context-usage`, `/cancel`, `/read` | GET, POST | Context usage; cancel the running turn; mark as read. |
| `/api/conversations/:id/tasks`, `/tasks/:taskId`, `/tasks/:taskId/cancel` | GET, POST | Background tasks of a conversation. |
| `/api/attachments` | POST, DELETE | Upload and remove an attachment. |
| `/api/transcribe` | POST | Transcribe recorded audio (Groq). |
| `/api/workspace/*` | GET | Read a workspace file (`?download` forces a download). |
| `/api/link-preview` | GET | Link preview for a URL. |
| `/api/mcp` | GET, PUT | MCP server settings. |
| `/api/voice/token` | POST | Issue a LiveKit token for a call. |
| `/api/voice/conversations/:id/call`, `/call/state` | GET | Call state for the voice agent. |
| `/api/voice/conversations/:id/call/updates/:updateId`, `.../ack` | POST | Call updates and their acknowledgement. |
| `/api/voice/conversations/:id/ended` | POST | Report that a call ended. |
| `/api/voice/conversations/:id/v1/chat/completions` | POST | OpenAI-compatible completions for the voice agent. |
| `/api/devices/register` | POST | Register a connected device. |
| `/api/devices/:name/events`, `/poll` | GET | Device event stream (SSE) and poll fallback. |
| `/api/devices/:name/heartbeat`, `/disconnect`, `/results` | POST | Device heartbeat, disconnect, and tool results. |
| `/api/devices/:name/files/:id` | POST | Upload a file for a pending device export. |
| `/internal/mcp/devices/:name` | ALL | A connected device's MCP endpoint, used by the agent server. |

Authentication: `/api/auth/*` is open, and login is rate limited. `/api/voice/conversations/*`
accepts the bearer `VOICE_GATEWAY_TOKEN`. `/api/devices/*` accepts the bearer
`ARTEMIS_DEVICE_TOKEN`. Every other `/api` route needs the browser session cookie, and cookie
requests must come from the same origin. `/internal/mcp/devices/:name` accepts only that
device's own credential, which the hub issues at registration.

## How the services talk

- **Browser to gateway:** HTTP and SSE under `/api`, through the nginx that serves the web app
  (or the Vite proxy in development). The gateway authenticates each request.
- **Gateway to agent server:** HTTP to `AGENT_SERVER_URL` with the bearer token
  `AGENT_SERVER_TOKEN`. The gateway relays JSON responses and SSE streams.
- **Agent server to gateway:** the gateway reads `MCP_DEVICE_BASE_URL` (default
  `http://127.0.0.1:<GATEWAY_PORT>`) and registers each connected device as a Streamable HTTP
  MCP server under that base URL, at `/internal/mcp/devices/:name`. The agent server, including
  its workers, calls those endpoints. Compose sets `MCP_DEVICE_BASE_URL=http://gateway:3000` on
  the gateway. Connected devices appear as MCP servers in the settings.
- **Agent server to its dependencies:** Postgres (`DATABASE_URL`), Hindsight (`HINDSIGHT_URL`,
  optional), and the model providers.
- **Voice agent:** WebRTC media through LiveKit (`LIVEKIT_URL`). Call state, call updates, and
  completions go to the gateway (`GATEWAY_URL`) under `/api/voice`. The gateway relays them to
  the agent server's `/v1/voice` routes. The voice agent refuses a plain-HTTP `GATEWAY_URL` unless
  the host is loopback, or a single-label Compose service name while `GATEWAY_ALLOW_PLAIN_HTTP_SERVICE`
  is set (Compose sets it on `voice-agent`).
- **Browser to LiveKit:** signaling through `/livekit/` on nginx. Media uses TCP 7881 and UDP
  7882. In Compose, the browser-facing URL is `ws://$IP_ADDRESS:$WEB_PORT/livekit` unless
  `LIVEKIT_PUBLIC_URL` overrides it.
- **Device client:** an authenticated HTTPS event connection and MCP JSON-RPC messages to the
  gateway's `/api/devices` routes. A remote gateway must be reached with `--server https://...`.

## Conversations, memory, and background work

Each conversation's state and event stream live in the agent server. The gateway forwards
requests and streams events, so an open browser shows voice turns as they happen.

Memory is shared across conversations. The memory coordinator retains completed,
user-visible turns to Hindsight in batches (every `MEMORY_RETAIN_EVERY` user turns) and
recalls relevant memories before each answer. A recall failure or timeout does not fail the
turn.

The agent server runs background work as tasks: subagents for delegated work, and command
processes for background shell commands. A finished task produces a background update. Some
updates wake their conversation at once; the rest arrive with its next turn.

On shutdown, running tasks end as `cancelled`. A task still marked running when the server next
boots is marked `failed`.

A device name held by a connected device is refused with HTTP 409, and the existing session is
kept. The name is free again once its device lapses without a heartbeat.

## Runtime data

Runtime data never lives inside an app or package. There are two host roots, and each must be
an absolute path. The gateway validates them at startup.

| Setting | Host (Compose default) | Mounted in containers | Contents |
|---|---|---|---|
| `WORKSPACE_PATH` | `./data/workspace` | `/workspace` in `agent-server` and `gateway` | The agent's workspace files. Agent shell commands run as `WORKSPACE_RUN_AS` (uid 1002, group 1001). The server writes uploads and device exports under `data/` (`data/attachments/`, `data/device-files/`), which the agent can read but not write. |
| `ARTEMIS_DATA_DIR` | `./data/gateway` | `/data/gateway` in `gateway` only | Gateway-only state, such as `attachment-retention.json`. The agent never sees it. |

In production the two roots must be set explicitly, must not be inside `apps/`, must be
separate and non-overlapping, and `ARTEMIS_DATA_DIR` must not be the default workspace root.
The `data/` folder at the repository top is gitignored and excluded from Docker build contexts.
See [Deployment](deployment.md#runtime-data) for the host ownership and modes.
