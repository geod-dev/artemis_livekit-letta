# Architecture

## Apps

Each directory under `apps/` is a deployable entry point. Apps never import each other.

- **`apps/web`** (`@artemis/web`) is a Vite React single-page app. The production
  build is static files served by nginx (`apps/web/nginx.conf`). nginx sends `/api` and
  `/health` to the gateway, `/livekit/` to LiveKit, and returns 404 for `/internal/`.
- **`apps/gateway`** (`@artemis/gateway`) is the public HTTP edge, on `GATEWAY_PORT`
  (default 3000). Entry point: `src/server.ts`. It checks the browser session
  (`ARTEMIS_PASSWORD`) and device tokens (`ARTEMIS_DEVICE_TOKEN`), serves attachments and
  workspace files, issues LiveKit tokens, and hosts the device hub. It proxies
  conversation, MCP, and voice requests, and their SSE streams, to the agent server.
- **`apps/agent-server`** (`@artemis/agent-server`) owns conversations, turns, events,
  background tasks and subagents, tools, the MCP registry, memory retention and recall,
  titles, and call state. Entry point: `src/main.ts`, on `AGENT_SERVER_PORT` (default
  4000). Its `/v1` API requires `AGENT_SERVER_TOKEN`. It runs database migrations at
  startup. Its prompts are bundled from `apps/agent-server/prompts/`.
- **`apps/voice-agent`** is a Python LiveKit worker (package `voice_agent`). It joins
  rooms, runs speech-to-text and text-to-speech, and talks only to the gateway's
  `/api/voice` routes: call state, call updates, and OpenAI-compatible chat completions.
- **`apps/device-client`** is a Python script that runs on a desktop and exposes selected
  local capabilities (browser, media, filesystem, terminal, screenshot) to the assistant
  through the gateway. See [its README](../apps/device-client/README.md).
- **`apps/mobile`** is an Android WebView wrapper that loads the HTTPS web app. It shares
  no code with the other apps. See [its README](../apps/mobile/README.md).

Infrastructure services in the Compose stack, with no code in this repository:
`postgres` (pgvector; databases `artemis` and `hindsight`), `hindsight` (memory service),
and `livekit` (WebRTC signaling and media).

## Packages

Packages under `packages/` are libraries. Each lists its own dependencies in `package.json`.

| Package | Role |
|---|---|
| `@artemis/contracts` | Wire types (`chat-types`, `agent-server`), present-tool validation and library, and generated present-tool JSON. No runtime dependencies. |
| `@artemis/core` | Shared primitives: clock, errors, ids, logger. |
| `@artemis/http` | Auth, errors, and SSE client and server helpers. |
| `@artemis/agent-loop` | The turn loop, run state machine, and one-shot runs. |
| `@artemis/llm` | Model provider interface and router. Vendors: `anthropic`, `openai-compatible`. |
| `@artemis/memory` | Memory store interface, rendering, and budgeting. Vendor: `hindsight`. |
| `@artemis/storage` | Persistence contracts and repositories, with migrations. Vendor: `postgres`. |
| `@artemis/mcp` | MCP registry, catalog, bridge, client, and settings. Vendor: `sdk`. |
| `@artemis/tools` | Tool definitions, toolsets, results, and workspace tools. |
| `@artemis/workspace` | Workspace interface and media types. Vendor: `filesystem`. |

## Dependency rules

`scripts/check-boundaries.mjs` enforces these rules. It parses every `.ts`, `.tsx`,
`.mjs`, and `.js` file under `apps/` and `packages/`, and it runs as the `boundaries`
check group.

1. `packages/contracts` imports nothing outside itself and has no runtime dependencies.
2. `packages/*` never import `apps/*`. They reach a vendor path only from inside their
   own `src/vendor`. Relative imports stay inside the package.
3. `apps/*` never import another app, and no relative path leaves their own root.
4. Only `apps/<app>/src/compose.ts` imports a vendor implementation.
5. `apps/web` imports only `@artemis/contracts` among workspace packages.
6. Every bare import is declared in the importing package's `package.json`.
7. The workspace package graph (`workspace:` and `link:` references) is acyclic.

Reviewed exceptions go in the `ALLOWLIST` array in the checker. It is empty.

## Vendor rule

Third-party implementations (Anthropic, OpenAI-compatible, Hindsight, Postgres, the MCP
SDK, the filesystem) live only in `packages/<name>/src/vendor/`, behind the package's
interface. The composition roots, `apps/agent-server/src/compose.ts` and
`apps/gateway/src/compose.ts`, are the only places that select them. Everything else
depends on the interface.

## How the services talk

- **Browser to gateway:** HTTP and SSE under `/api`, through the nginx that serves the
  web app (or the Vite proxy in development). The gateway authenticates each request.
- **Gateway to agent server:** HTTP to `AGENT_SERVER_URL` with the bearer token
  `AGENT_SERVER_TOKEN`. The gateway relays JSON responses and SSE streams.
  Conversation events come from `/v1/conversations/:id/events`, and the gateway serves
  them at `/api/conversations/:id/events`.
- **Agent server to gateway:** the agent server calls the gateway's internal device MCP
  endpoints at `MCP_DEVICE_BASE_URL` (`/internal/mcp/devices`). Connected devices appear as
  MCP servers.
- **Agent server to its dependencies:** Postgres (`DATABASE_URL`), Hindsight
  (`HINDSIGHT_URL`, optional), and the model providers.
- **Voice agent:** WebRTC media through LiveKit (`LIVEKIT_URL`). Call state, call updates,
  and completions go to the gateway (`GATEWAY_URL`) under `/api/voice`. The gateway relays
  them to the agent server's `/v1/voice` routes.
- **Browser to LiveKit:** signaling through `/livekit/` on nginx. Media uses TCP 7881 and
  UDP 7882.
- **Device client:** an authenticated HTTPS event connection and MCP JSON-RPC messages to
  the gateway's `/api/devices` routes.

## Conversations, memory, and background work

Each conversation's state and event stream live in the agent server. The gateway forwards
requests and streams events, so an open browser shows voice turns as they happen.

Memory is shared across conversations. The memory coordinator retains completed,
user-visible turns to Hindsight in batches (every `MEMORY_RETAIN_EVERY` user turns) and
recalls relevant memories before each answer. A recall failure or timeout does not fail
the turn.

The agent server runs background work as tasks: subagents for delegated work, and command
processes for background shell commands. A finished task produces a background update.
Some updates wake their conversation at once; the rest arrive with its next turn.

## Runtime data

Runtime data never lives inside an app or package. There are two host roots, and each must
be an absolute path. The gateway validates them at startup.

| Setting | Host (Compose default) | Mounted in containers | Contents |
|---|---|---|---|
| `WORKSPACE_PATH` | `./data/workspace` | `/workspace` in `agent-server` and `gateway` | The agent's workspace files. Commands run as `WORKSPACE_RUN_AS` (uid 1001). |
| `ARTEMIS_DATA_DIR` | `./data/gateway` | `/data/gateway` in `gateway` only | Gateway state under the workspace-relative `data/` path: `data/attachments/`, `data/attachment-retention.json`, and `data/device-files/`. |

In production the two roots must be set explicitly, must not be inside `apps/`, must be
separate and non-overlapping, and `ARTEMIS_DATA_DIR` must not be the default workspace
root. The `data/` folder at the repository top is gitignored and excluded from Docker
build contexts. See [Deployment](deployment.md) for the production mounts.
