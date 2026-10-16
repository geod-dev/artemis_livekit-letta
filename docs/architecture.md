# Architecture

## Services

- `frontend/` is a static React app. It sends HTTP requests and listens to server-sent events through the nginx `/api` route.
- `backend/` is the authenticated gateway. It owns conversations, files, voice tokens, device endpoints, model selection, and background task state.
- `infrastructure/letta/` owns the Letta image, pinned compatibility patch, custom agent definitions, and runtime extensions mounted into the Letta volume. Compose remains the deployment entry point.
- `agent/` joins LiveKit rooms and handles speech recognition, turn detection, speech generation, and call lifecycle. It sends each completed user utterance to the backend's OpenAI-compatible voice route.
- `livekit` provides WebRTC signaling and media transport. Browser signaling goes through `/livekit/` on nginx; the agent uses the internal Compose address.

## Conversation and files

Application components built with assistant-ui are grouped by responsibility
under `frontend/src/components/assistant-ui/`: `chat/`, `composer/`, `tools/`,
`files/`, `markdown/`, and `shared/`. These are maintained application code,
with ordinary `.tsx` filenames. The reasoning message adapter and disclosure
UI have separate names. Pure media, result-formatting, and protocol helpers
live in `frontend/src/lib/`; public API types live in `shared/contracts/`.

The backend keeps one Letta session per conversation and serializes text, voice,
and delivered background results through it. Its event feed lets an open browser
show voice turns while they happen. Letta's memory belongs to the agent, so new
conversations share the same learned information.

The composer uses assistant-ui's `ComposerContext` element with the latest
`usage_statistics.context_tokens` snapshot emitted by Letta. This is Letta's
estimate for its assembled context, including prompt, tools, memory and history;
cumulative billable token counts and visible transcript length are not used.
The denominator comes from Letta's effective conversation context limit, with an
agent fallback. Snapshots are retained in the backend data directory. The ring
appears only in conversations with reported usage; an unknown usage or limit
does not become a guessed reading. The element shows the aggregate because the
local App Server does not report a category breakdown through this stream.

Backend ownership follows those boundaries: `assistant/runtime/` adapts SDK
sessions and schedules turns; `assistant/conversations/`, `assistant/calls/`,
and `assistant/background/` own their respective domain state; `assistant/letta/`
contains the agent-client, management-socket, and model adapters. The
`assistant/filesystem/workspace-adapter.ts` handles workspace reads, uploaded
files, and attachment retention. `routes/letta-callbacks.ts` is the HTTP
boundary for callbacks from Letta mods, while the mods themselves live under
`infrastructure/letta/extensions/`.

The host workspace is mounted at `/workspace` for both the backend and Letta.
The backend's attachments and operational state live under its separate data
root, mounted in the backend at `/data/backend` and read-only in Letta at
`/workspace/data`. Files shared by the assistant outside that data directory
remain in the workspace. The backend serves workspace files through a confined,
read-only route; HTML and other text are not executed as pages.

Attachment retention distinguishes uploads from generated tool outputs. Unreferenced
uploads expire after 24 hours; referenced uploads remain available. Generated
outputs are preserved for deliberate cleanup, including after a restart before
their canonical history references are recovered. Legacy retention records are
treated conservatively as generated outputs. Pending output reference tokens are
durable and capped at 2,048; reaching that cap rejects another handoff rather than
discarding a potentially referenced output. Ordinary workspace files are outside
automatic attachment collection.

History requests use provider cursors. Internal operations that require a complete
conversation or attachment listing stop after 100 pages of 100 rows and return
an explicit unavailable error if the provider exceeds that bound or repeats a
cursor. They do not proceed with an incomplete list.

## Background work

Letta runs and manages worker agents. The backend keeps the pieces Letta does
not persist for this app: task origin, results waiting for delivery, and read
markers. A completed result joins its source conversation on a later turn.
Workers signal a request for user input with the `NEEDS USER INPUT:` convention.

## Android wrapper

The Android app is a single WebView around the hosted frontend. The site remains
the product UI; Android supplies microphone permission, file picking, downloads,
system bars, and back navigation. Same-origin downloads and previews stay in the
authenticated WebView session. External hosts open separately and receive no
WebView cookies.
