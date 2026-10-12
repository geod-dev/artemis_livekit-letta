# Persistent assistant — Letta + LiveKit

One personal assistant you can talk to by **text** or **voice**, with one identity, one memory and one
conversation history. Start a chat by typing, press the call button, keep talking — the spoken turns land
in the same conversation, and whatever the assistant learns is available everywhere afterwards.

```
 frontend/ (Vite + React, :5173)        ┌──────────────── backend/ (Node + Hono, :3000) ──────────────┐
 chat UI ── /api (proxy) ── text ──────▶│ /api/conversations/*   ─┐                                   │
   │   ◀─ SSE ──────────────────────────│ /api/conversations/:id/events (live feed)                   │
   │   ◀─ files ────────────────────────│ /api/attachments, /api/workspace/<path>  ◀── .workspace/ ──┐ │
   │                                    │                         ▼                                  │ │
   │                                    │           assistant (src/assistant)                        │ │──WS──▶ Letta App Server
   │                                    │ /api/voice/token  · one Letta session per conversation     │ │       (agent, memory,
   │                                    │ /api/voice/…/v1/chat/completions · model per modality      │ │        conversations,
   │                                    │ /api/voice/…/call (control channel) · call state           │ │        native workers,
   │                                    │                   · background updates, read state         │ │        reflection)
   │                                    │ /api/letta/notifications ◀────────────────────────────────────────── notifications mod
   │                                    └─────────────────────────────▲──────────────────────────────┘ │
   │ WebRTC                                                           │                                └── mounted as /workspace,
   ▼                                                                  │ OpenAI-compatible stream          the agent's working directory
 LiveKit server ◀──────────▶ agent/ (Python, livekit-agents): STT ─ turn detection ─ TTS ─ call lifecycle
```

## How it fits together

**Letta is the brain and the store.** A single Letta agent (`LETTA_AGENT_NAME`) holds the persona and
everything known about the user in its MemFS memory (git-backed markdown files; the root files are compiled
into every prompt). Each chat is a Letta *conversation* on that agent: the sidebar, text turns and voice
turns all read and write Letta conversations. Letta also runs, identifies and stops background workers. The
backend keeps one small JSON file (`backend/.workspace/data/background.json`) for what Letta has no place
for: where a background task was started from, results held for a later turn, and read markers.

**Two small apps.** The frontend (`frontend/`) is a static React app; it only talks to the backend's HTTP
API, through the `/api` proxy of its dev server, and imports the API's types (`backend/src/chat-types.ts`)
as types only. The backend (`backend/`) is the gateway, called by the frontend, the voice agent and Letta's
notifications mod.

**The backend (`backend/src/assistant`) is the single entry point to Letta.** It keeps one Letta session per
conversation and serializes every turn through it, whoever produced it — text chat, voice, or a background
result being delivered. Every turn is fanned out to an in-process event feed, which the browser follows
over SSE; that is how voice turns show up live in an open chat. Each session is read by one continuous
reader that hands messages only to the turn being run (Letta also emits messages between turns), and
worker transcripts that Letta forwards to the parent session are dropped at the socket.

**The workspace is how files move.** `backend/.workspace/` is mounted into the Letta container as
`/workspace`, the agent's working directory (its tools run there). The backend keeps its own files under
`data/`: attachments (`data/attachments/<uuid>/<name>`) and its state file. The container mounts `data/`
read-only, so the agent can read attachments but never change backend data; to edit an attachment it copies
it out first (e.g. to `files/`). Everything else in the workspace belongs to the agent.
- A user turn names its attachments with their workspace path: `<attachment kind="file"
  path="data/attachments/…" name="…" />` before the user's words. Images are also sent inline.
- `GET /api/workspace/<path>` serves any workspace file (read-only, confined to the workspace, symbolic links
  included). Viewable types are shown inline, `?download` forces a download; text formats (including HTML)
  are served as plain text, and responses carry `Content-Security-Policy: sandbox`, so no file runs as a page.
- The agent shares a file with a plain markdown link to its workspace path, `[report.xlsx](files/report.xlsx)`
  (or `![chart](files/chart.png)` for an inline image). The frontend renders such links, in replies and in
  worker reports, as file cards: name and size, a preview for images, open (viewable types) and download.
  No tool is involved.
- The system prompt describes this environment; the id of the current conversation is in the agent's shell
  as `$CONVERSATION_ID` (Letta sets it per command; the system prompt itself is shared by all conversations).
- The system prompt is `backend/prompts/system.md` (`{{name}}` and `{{workspace}}` are filled in). The backend
  sets it on the agent when it starts, and `pnpm dev` restarts on edits. Letta compiles the prompt into each
  conversation when the conversation is created and when it recompiles it (after memory updates), so an edit
  reaches new chats first.
- The Letta image adds Python libraries for file work (openpyxl, pandas, Pillow, matplotlib, plus pip and
  venv). Only `/workspace` and `/root/.letta` persist across container recreation.

**Diagrams and generative UI (text turns).** Replies render as Streamdown markdown (assistant-ui's
`@assistant-ui/react-streamdown`). A fenced `mermaid` block is drawn as a diagram by Streamdown's Mermaid plugin
(`@streamdown/mermaid`, loaded with the first diagram), redrawn as it streams. For interactive views the
assistant calls the `present` client tool with a JSON tree of components (`{ "$type": "Card", …, "children": [...] }`)
from assistant-ui's generative UI vocabulary (`@assistant-ui/react-generative-ui`: cards, facts, tables, charts,
lists, forms, buttons…). The backend only checks the component names and answers "shown"; the frontend
registers a render-only toolkit entry for `present` (`elements/generative-ui.tsx`) that draws the call's
arguments with `renderGenerativeUI`. The tool's schema is generated from the frontend's library into
`backend/src/assistant/present-tool.json` (`pnpm generate:present-tool` in `frontend/`; a test fails when they
differ). Controls answer through one action, `reply`, which sends the user's choice (and a form's fields) as
their next message. `present` is registered for text turns only: its schema adds ~6k tokens to a request.

**Every turn states its mode.** User messages are stored as `[text] …`, `[voice-short] …` or
`[voice-long] …`; the system prompt defines the modes, the UI shows voice turns as "spoken", and messages
stored with the older `[voice]` prefix still decode.

**One conversation, two models.** A conversation's model follows the modality of each turn: the *fast* model
(DeepSeek V4 Flash on Telnyx) for voice, the *smart* one (e.g. GLM-5.3-Flash) for text. The fast model also
does small side jobs, such as naming a conversation from its first message. Switching is a cheap Letta call
made only when the modality changes (and pre-emptively when a call starts).

**Voice path.** The Python agent does audio and call timing: STT, turn detection, TTS, and when to hang up
or speak a background update. Its LLM is the stock LiveKit OpenAI plugin pointed at
`/api/voice/conversations/<id>/v1` — an OpenAI-compatible endpoint that forwards each finished user
utterance into the Letta conversation and streams the reply back. Letta adds ~25 ms per turn when warm
(measured in its Linux container), so it was kept in the realtime path instead of building a second "voice
brain" and a transcript store. Preemptive generation is disabled on purpose: the backend is stateful, so only
finished user turns are sent. Interrupting the assistant aborts the Letta turn.

**Call modes.** A call is *short* or *long*. Its starting mode comes from the agent dispatch metadata
(`call_mode`, default short); the frontend starts its calls in long mode. The `set_call_mode` tool switches it
during the call:
- **Short**: the call ends once the assistant's final response has finished playing. Every voice response
  ends with an explicit state marker, `[listen]` (it waits for the user's answer) or `[done]`; the gateway
  removes it before speech and display and records it as the response's state. Only `[done]` ends a short
  call, so a missing marker keeps the call open. Each voice turn carries a short reminder of the marker,
  which the fast model needs to follow it reliably.
- **Long**: the frontend's default, also entered with the `set_call_mode` tool when the user asks for a
  longer conversation; it stays open until the assistant calls `end_call` (the user says goodbye) or the user
  hangs up.

The decision is made by the voice agent (`agent/src/voice_agent/call.py`) when a response has *finished
playing*: it asks the gateway (`GET …/call/state`) and, if the call ends, waits a short grace period
(speaking in it keeps the call), closes the session and deletes the room. Interrupted replies never end a
call; a short call whose user goes silent (LiveKit's "away" state) ends; a long one does not. The agent keeps
a control channel open for the call (`GET …/call`, SSE); while it is open the gateway counts the call as
active.

**Memory follows Letta's lifecycle.** The assistant reads its memory in every prompt and maintains it three ways:
- a direct request ("remember that…", "forget…") is handled in the turn: the assistant edits the MemFS files
  with its file tools and commits before confirming;
- an incidental fact is handed to Letta's background `memory` worker while the reply continues;
- Letta *reflection* reviews the transcript in the background, every `ASSISTANT_REFLECTION_STEPS` agent
  steps (Letta "dreaming") and after every call (`/api/voice/conversations/<id>/ended`), switched back to the
  smart model first because reflection runs on the conversation's current model.

**Quick actions vs. background work.** Client tools (`backend/src/assistant/tools.ts`) run inline, never moved to
Letta's background, so their outcome is part of the response. Longer work goes to Letta's native workers
through the built-in `Agent` tool; starting one only means the work was accepted, and the prompt keeps the
two acknowledgements apart. The assistant gives a worker more instructions by resuming it with its
`conversation_id`, and cancels it with `TaskStop`. In text chat, user work is delegated only when the user
explicitly asks; in calls, research and multi-step work goes to a worker.

The `research` worker is a native Letta subagent definition (`letta/agents/research.md`, installed by
`letta/setup.mjs`) on `ASSISTANT_TASK_MODEL`.

**MCP servers** (web search and any other tools) are added in the app: Settings → MCP servers. It is one
list shared by every agent, following [lettuce](https://github.com/dmarcelino/lettuce). Letta keeps MCP
servers per agent in its `settings.json`, but the running server rewrites that file from memory and drops
outside edits, so the backend (`backend/src/mcp/`) writes the list to a settings file of its own in the
Letta volume (`/root/.letta/mcp-home/.letta/settings.json`, through the App Server's `write_file`). Agents
reach it two ways:
- the assistant through four native tools, `mcp_search` → `mcp_describe` → `mcp_call` (read-only tools,
  by the server's `readOnlyHint`) or `mcp_call_write`: a Letta mod the backend renders into
  `/root/.letta/mods/mcp-bridge.mjs` calls the backend (`/api/letta/tools/<name>`), which is the MCP client
  for http and sse servers (`backend/src/mcp-bridge/`);
- workers (which get no mod tools) and stdio servers through the `mcp-servers` skill, whose wrapper runs
  `letta mcp` against the shared file: `sh /root/.letta/skills/mcp-servers/scripts/mcp.sh search|call …`.
A save applies on the agents' next turn, without a restart.

**Background results.** Letta delivers a finished task as a `<task-notification>` and starts a turn with it
on its own. The Letta mod `letta/notifications.mjs` hands these notifications to the gateway
(`/api/letta/notifications`) instead; notifications queued while a turn is running are taken out of Letta's
queue by the gateway (`remove_queue_item`) before Letta can merge them into that turn. The gateway
(`backend/src/assistant/background.ts`) then decides with the mode captured when the work started:
- started in a **short call** and successful: the thread is not woken; the result is held, shown in the chat
  and delivered with the conversation's next turn;
- started in a **long call** or in **text**, a **failure**, or a report starting with
  `NEEDS USER INPUT:`: the thread is woken;
- work stopped with `TaskStop`, and work started while answering an update, never wake it (no loops);
  duplicate notifications are dropped.

A woken result is delivered according to the call state *at that moment*: during an active call it is
queued as a spoken update, which the voice agent speaks once nobody is talking (the gateway runs a voice turn
for it and streams the text); otherwise the smart model writes a text reply at low effort. The worker's full
report stays in the chat (the "Report" button on the result).

**Read state.** A background result stays unread (sidebar dot, "New" label) until it has been visible in the
chat, in a focused window, for a moment, or until its spoken update played to the end. Receiving it over the
network does not count; an interrupted or failed spoken update leaves it unread, and an update that was
queued but never spoken goes to the chat as text when the call ends.

## Repository layout

```
docker-compose.yml   Full stack: Letta, LiveKit, backend, frontend and voice agent
.env.example         shared settings, including the single host IP_ADDRESS
letta/               mounted into the Letta container
  setup.mjs            installs subagent definitions before the server starts
  agents/research.md   the research worker (native Letta subagent)
  notifications.mjs    mod: hands background-task notifications to the backend
  telnyx.mjs           mod: Telnyx model capabilities (reasoning tiers)
backend/             Node HTTP API (Hono), run with tsx
  src/server.ts        the routes, under /api
  src/routes/          conversations, live events, read markers, attachments and workspace files,
                       voice token, voice LLM endpoint, call control channel, spoken updates,
                       Letta notifications, link previews, transcription
  prompts/system.md    the assistant's system prompt
  src/assistant/       Letta client, runtime, call state, background results, workspace, tools, prompts
  src/mcp/             the shared MCP list, its `mcp-servers` skill, the native tools' wiring
  src/mcp-bridge/      the `mcp_*` tools: MCP client, tool catalog, handlers
  src/internal-tools/  rendering and reloading the Letta mods whose tools call the backend
  src/chat-types.ts    the API types (imported by the frontend as types only)
  .workspace/          the agent's workspace (git-ignored), mounted as /workspace; data/ is the backend's
frontend/            React app (Vite; UI based on livekit-examples/agent-starter-react)
  src/components/chat/ sidebar, message list, composer, call bar
  src/components/settings/  Settings (MCP servers)
  src/components/assistant-ui/elements/workspace-file.tsx   file cards for workspace links
agent/               Python LiveKit agent (uv)
  src/voice_agent/     entrypoint, call lifecycle, gateway client, speech provider factory, config
```

## Running it

Requirements for the complete stack: Docker with Docker Compose. No host Node or Python installation is needed.

```bash
cp .env.example .env           # then fill in the provider keys you use
docker compose up --build -d   # builds and starts every service
```

Set `IP_ADDRESS` once in `.env` to the IPv4 address clients use to reach this host. Use
`127.0.0.1` for local testing; for another device or a deployment, use the host's reachable LAN/public
address. The app is at `http://<IP_ADDRESS>:5173`. LiveKit uses the same address for its websocket and
WebRTC media. Docker publishes the web app and LiveKit ports; the backend and Letta stay inside Docker's
private network. Allow inbound TCP ports 5173, 7880, and 7881, plus UDP port 7882, in the VPS firewall.
For voice calls from a remote browser, serve the app and LiveKit over HTTPS/WSS with a trusted certificate;
browser microphone access requires a secure origin.

Minimum keys: one LLM provider for the models you select (e.g. Telnyx through
`OPENAI_COMPATIBLE_BASE_URL/_API_KEY`) and the speech provider (`DEEPGRAM_API_KEY` for the default Flux
STT/TTS). The agent is created on first use; to start over, delete it (or change `LETTA_AGENT_NAME`), or
remove the `letta-data` volume. For web search, add an MCP server in Settings → MCP servers.

To stop the stack, run `docker compose down`. Letta data and the backend workspace remain on disk. To follow
startup output, run `docker compose logs -f`.

### Local development

Use `IP_ADDRESS=127.0.0.1` in `.env` for local work. Install Node ≥ 22.19 with pnpm and Python ≥ 3.11 with
[uv](https://docs.astral.sh/uv/). Start the supporting services:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d letta livekit
```

Then run these in separate terminals from the repository root (install each project's dependencies once):

```bash
cd backend && pnpm install && pnpm dev
cd frontend && pnpm install && pnpm dev
cd agent && uv sync && uv run agent dev
```

Open `http://127.0.0.1:5173`. The Vite server proxies API requests to the backend, and the dev override
lets Letta send background notifications to the host backend.

Other commands:

```bash
cd backend  && pnpm typecheck && pnpm lint && pnpm test
cd frontend && pnpm typecheck && pnpm lint && pnpm test && pnpm build   # `pnpm preview` serves the build
cd agent && uv run pytest && uv run ruff check src tests && uv run pyright
node --test letta/*.test.mjs        # Letta mods, from the repository root
```

## Configuration

| Setting | Meaning |
|---|---|
| `ASSISTANT_SMART_MODEL`, `ASSISTANT_SMART_REASONING` | Letta model handle + reasoning tier for text turns (and reflection after calls) |
| `ASSISTANT_FAST_MODEL`, `ASSISTANT_FAST_REASONING` | same, for voice turns and side jobs (conversation titles) — keep it fast |
| `ASSISTANT_TASK_MODEL` | model of the `research` worker (empty: the worker inherits the conversation's model) |
| `ASSISTANT_REFLECTION_STEPS` | background reflection interval, in agent steps |
| `VOICE_STT`, `VOICE_TTS`, `VOICE_TTS_VOICE` | `<provider>/<model-or-voice>`: `deepgram`, `telnyx`, `openai`, `cartesia`, `elevenlabs`, `inference` |
| `IP_ADDRESS` | host address advertised to browsers and used for published service ports (`127.0.0.1` locally) |
| `OPENAI_COMPATIBLE_BASE_URL/_API_KEY` | optional extra OpenAI-compatible provider for Letta (`openai-compatible/<model>`), served under `/v1` by the compose proxy |
| `ASSISTANT_GATEWAY_URL` | where the Letta container reaches the backend for background notifications |
| `BACKEND_PORT`, `BACKEND_URL` | the backend's port (default 3000), and where the frontend proxies `/api` to |

Model handles are Letta's `<provider>/<model>`: e.g. `openai-compatible/deepseek-ai/DeepSeek-V4-Flash-0731`
(Telnyx), `zai/glm-5.3`, `openai/gpt-4.1-mini`. Deepgram Flux STT (`deepgram/flux-…`) also performs
end-of-turn detection; other STT providers use LiveKit's local turn-detector model.

### Groq Qwen compatibility

The fast model no longer runs on Groq; this patch only matters if a `groq/qwen/…` handle is selected again.
Compose builds a small custom image from `letta/letta:0.34.4`. The patch in
`infrastructure/letta` sets Pi's existing `supportsDeveloperRole` capability to `false` only
when the provider is `groq` and the model ID starts with `qwen/`. Pi then sends the assistant
instructions and compiled memory as `system`; user messages keep their `user` role. Native
`groq/...` handles still work, and selecting another provider automatically bypasses the override.
No prompts, model settings, or stored conversations are changed.

Apply it with `docker compose up -d --build letta`. The build checks the exact Letta version and
adapter entry point and fails if either changes, so upgrades require revalidating the workaround.
To remove it once upstream fixes compatibility, restore the official image in Compose and remove
the `build` entry. Adapter checks run against the original published 0.34.4 bundle:

```powershell
$env:LETTA_BUNDLE = 'path/to/original/package/letta.js'
node --test infrastructure/letta/patch-groq-qwen.test.mjs
```

## Telnyx models and response effort

The fast model is DeepSeek V4 Flash on Telnyx: `openai-compatible/deepseek-ai/DeepSeek-V4-Flash-0731`
(Telnyx's [release note](https://telnyx.com/release-notes/deepseek-v4-flash-qwen3-8-27b-inference) gives
the model ID). It thinks only when a `reasoning_effort` is sent, so voice turns use
`ASSISTANT_FAST_REASONING=none` and send none; its thinking tiers map to DeepSeek's `high` and `max`
(SDK `high`/`xhigh`).

For GLM-5.3 and GLM-5.3-Flash, the text slider's three smart positions map to
`low`, `high`, and `max` (UI labels Low, Medium, High). Telnyx's
[quickstart](https://developers.telnyx.com/docs/inference/getting-started) sends
`reasoning_effort` directly; [GLM's model card](https://huggingface.co/zai-org/GLM-5.3-Flash)
documents these three supported values.

Compose mounts `letta/telnyx.mjs` as a global Letta provider mod. It activates only
when `OPENAI_COMPATIBLE_BASE_URL` points to `api.telnyx.com`, preserving existing
`openai-compatible/<model>` handles and adding the reasoning capabilities of GLM-5.3
and DeepSeek V4 Flash. This is necessary because Letta 0.34.4's generic
OpenAI-compatible discovery marks models as non-reasoning and disables sending
reasoning effort. The SDK calls the highest tier `xhigh`; the mod translates that
tier to `max` in the HTTP request. Explicit slider selections fail visibly if a
tier cannot be applied.

After adding the mod, recreate Letta with `docker compose up -d --build letta`.
Run `node --test letta/telnyx.test.mjs` from the repository root to verify the
outgoing HTTP values using the pinned backend's streaming adapter.

## Latency notes

Measured on this prototype (Windows host, Letta and LiveKit via `docker compose`, with the gateway then
served by a production Next.js build, Deepgram Flux STT/TTS, OpenAI `gpt-4.1-nano` as the voice model): end
of user speech → agent audio
≈ 1.6–1.7 s, made of end-of-turn ≈ 500 ms + LLM first token ≈ 0.8 s (the model's own TTFT; Letta and the
gateway add tens of ms) + TTS first byte ≈ 0.3–0.4 s. With Cerebras the LLM step drops to a few hundred ms.
The agent logs this breakdown per turn (`turn latency:`), the gateway logs
`[assistant] voice-short turn … first token …`. DeepSeek V4 Flash on Telnyx gave a first token in
≈ 0.8–2 s through Letta in this setup. The voice agent calls the backend directly; the frontend is not in
the voice path.

## HTTPS on a public VPS

Public deployments need HTTPS: microphone recording and `crypto.randomUUID()`
(used when sending messages and uploading files) require a secure browser context.
Localhost is trusted by browsers, which is why HTTP works during local development.

For a Debian/Ubuntu VPS without a domain, install nginx and Certbot **5.4 or newer**
(older distro packages do not support IP certificates with webroot validation).
For example, with uv installed: `uv tool install 'certbot>=5.4'`.
Set `IP_ADDRESS` in `.env` to the public IPv4 address, allow inbound TCP 80/443
and LiveKit media TCP 7881/UDP 7882, then run as root:

```sh
CERTBOT=/root/.local/bin/certbot sh infrastructure/https/setup.sh 185.252.233.123
```

The script obtains a publicly trusted Let's Encrypt IP certificate, rebuilds the
app, serves it at `https://185.252.233.123`, and redirects HTTP (including the old
port 5173) there. It binds the frontend to loopback port 5180 and routes browser
LiveKit signaling through `wss://185.252.233.123/livekit`; the voice agent continues
using the internal Docker address. API event streams remain unbuffered.
IP certificates last six days, so a systemd timer checks for renewal every six
hours and reloads nginx after renewal. Port 80 must remain accessible for renewal.
Replace the example IP with your own. The script backs up `.env` before changing
the three deployment settings; rerunning it preserves existing certificates.

## Known limitations

- Single user, protected by `ARTEMIS_PASSWORD` in `.env` (required). Browser sessions last 90 days; changing the password and restarting the backend revokes them. Connected devices use the separate `ARTEMIS_DEVICE_TOKEN` and appear as automatically managed servers in the shared MCP list; see [device setup](devices/README.md).
- The live event feed is in-process: run one backend instance (fine for a personal assistant).
- Letta's current App Server (Letta Code 0.34) has no API to append a message without running a turn, which
  is why voice turns go through Letta rather than being logged afterwards, and why a held background result
  joins the conversation with its next turn.
- Letta Code 0.34.4 has no setting to filter or defer task notifications, and merges notifications queued
  during a turn into that turn's tool continuations without a `turn_start` event. The gateway's mod and
  queue claim cover both paths; a notification Letta consumes in the instant between being queued and
  being claimed is delivered natively, inside the running turn.
- Letta-to-Letta `SendAgentMessage` requires the Cloud backend; on the local backend a worker gets follow-up
  instructions by being resumed with its `conversation_id` (a new task). There is no task-listing tool;
  workers are inspected through their output file (`Read`) or Letta's subagent state events.
- Workers have no "needs input" status; the `NEEDS USER INPUT:` first line is this app's convention, set in
  the research worker's definition and the assistant's instructions to other workers.
- Web search on the local backend comes from MCP servers (Settings → MCP servers); Letta's own
  `web_search` tool needs the Cloud backend.
- Letta has no protocol command for MCP servers, and its per-agent `mcpServers` do not survive outside
  edits while it runs, hence the shared list in its own file. Letta's "MCP servers with available tools:
  None" reminder and plain `letta mcp` read the per-agent list, so they show nothing; the `mcp-servers`
  skill's description says so.
- The fast model does not always keep spoken updates to one or two sentences, and can occasionally leak
  self-talk into a voice reply.
