# Architecture

## Services

- `frontend/` is a static React app. It sends HTTP requests and listens to server-sent events through the nginx `/api` route.
- `backend/` is the authenticated gateway. It owns authentication, files and workspace serving, voice tokens, and device endpoints. It proxies conversation, MCP, and voice routes to the agent server.
- `services/agent-server/` owns conversation state and events, workers and background tasks, tools, MCP, the memory coordinator, titles, call state, and voice completions. Its `/v1` API requires `AGENT_SERVER_TOKEN`.
- `postgres` (pgvector) stores the agent server's database `artemis` and Hindsight's database `hindsight`.
- `hindsight` is the memory service. The agent server retains and recalls memories over its HTTP API.
- `agent/` joins LiveKit rooms and handles speech recognition, turn detection, speech generation, and call lifecycle. It sends each completed user utterance to the backend's OpenAI-compatible voice route.
- `livekit` provides WebRTC signaling and media transport. Browser signaling goes through `/livekit/` on nginx; the agent uses the internal Compose address.

The detailed design is in [migration-hindsight/architecture.md](migration-hindsight/architecture.md).

## Conversation and files

Application components built with assistant-ui are grouped by responsibility
under `frontend/src/components/assistant-ui/`: `chat/`, `composer/`, `tools/`,
`files/`, `markdown/`, and `shared/`. These are maintained application code,
with ordinary `.tsx` filenames. The reasoning message adapter and disclosure
UI have separate names. Pure media, result-formatting, and protocol helpers
live in `frontend/src/lib/`; public API types live in `shared/contracts/`.

The agent server owns each conversation's state and event streams
(`/v1/conversations/:id/events`). The backend forwards requests and streams
events to the browser, so an open browser shows voice turns while they happen.

The composer's context ring reads `GET /v1/conversations/:id/context-usage`. The
endpoint returns null when usage is unknown, and the ring is not shown in that case.

Memory is shared across conversations. The memory coordinator retains completed
user-visible turns to Hindsight in batches (every `MEMORY_RETAIN_EVERY` user turns)
and recalls relevant memories before each answer. A recall failure or timeout
does not fail the turn.

The host workspace is mounted at `/workspace` in both `agent-server` and `backend`.
The data root (`ASSISTANT_DATA_ROOT`) is mounted at `/workspace/data` in
`agent-server` and at `/data/backend` in `backend`. The containers write to the
data root; agent commands run as an unprivileged `workspace` user (uid 1001) that
can read it but not write it. The backend serves workspace files through a
confined, read-only route; HTML and other text are not executed as pages.

Attachment retention distinguishes uploads from generated tool outputs. Unreferenced
uploads expire after 24 hours; referenced uploads remain available. Generated
outputs are preserved for deliberate cleanup. Ordinary workspace files are outside
automatic attachment collection.

## Background work

The agent server runs background work as tasks, each with its own worker: a
subagent for delegated work, or a command process for background shell commands.
When a task finishes, its result becomes a background update. Some updates wake
their conversation right away; the rest are delivered with its next turn.

## Android wrapper

The Android app is a single WebView around the hosted frontend. The site remains
the product UI; Android supplies microphone permission, file picking, downloads,
system bars, and back navigation. Same-origin downloads and previews stay in the
authenticated WebView session. External hosts open separately and receive no
WebView cookies.
