# Migration: Letta -> agent-server + Hindsight

Status: design spec. Code contracts live in `packages/*`, `services/agent-server`, `shared/contracts`.
Work plan: [tasks.md](tasks.md). At the end, no Letta code, dependency, container, env var, doc or check remains.

## 1. Services and containers

```
browser ──HTTPS──> frontend (nginx) ──/api──> backend = GATEWAY (:3000) ──/v1 + SSE──> agent-server (:4000)
                                                │  auth, devices, LiveKit tokens,          │  conversations, workers, tools,
                                                │  attachments/files, transcription,        │  MCP, memory coordinator, titles,
                                                │  link preview, proxy                      │  calls state, voice completions
voice-agent (LiveKit, Python) ──/api/voice──────┘                                           │
devices ──/api/devices──> gateway ──(device MCP at /internal/mcp/devices/:name)<──MCP client─┤
                                                                                            ├──> postgres (pgvector/pgvector:pg18)
hindsight (ghcr.io/vectorize-io/hindsight:1.1.0, :8888) ──────────────────> postgres        │      db `artemis`  (agent-server)
                         <──────────── retain / recall (HTTP) ──────────────────────────────┤      db `hindsight` (Hindsight)
livekit (:7880)                                                                             └──> Anthropic API / Telnyx (OpenAI-compatible)
```

Containers (compose): `postgres`, `hindsight`, `agent-server`, `backend`, `frontend`, `livekit`, `voice-agent`.
Removed: `letta`, `openai-compatible-proxy`, volume `letta-data`.

Volumes: `postgres-data`; workspace `${WORKSPACE_PATH}:/workspace` mounted RW in `agent-server` and `backend`;
`${ASSISTANT_DATA_ROOT}` mounted at `/workspace/data` in both (agent-server writes artifacts and task logs
there; agent commands run as an unprivileged `workspace` user that can read but not write `data/`).

## 2. Package layout

One pnpm workspace (`pnpm-workspace.yaml`, single root `pnpm-lock.yaml`) for every Node package except
`frontend/` (keeps its own hoisted install; it imports `shared/contracts` by path alias). TypeScript runs from
source with `tsx` (no build step), `tsc --noEmit` typechecks, `tsx --test` runs `src/**/*.test.ts`.
Packages expose `.ts` entry points via `exports` (subpath exports for vendor implementations).

```
shared/                     @artemis/contracts   type-only API contracts (chat-types.ts, agent-server.ts) + present JSON
packages/core               @artemis/core        SerialScheduler, KeyedRegistry (idle reaper), Clock, Logger, errors, ids
packages/http               @artemis/http        SSE server stream, SSE client parser, bearer check, error responses
packages/llm                @artemis/llm         LlmProvider + canonical types, ProviderRegistry, ModelRoute
                              /anthropic           AnthropicLlmProvider (@anthropic-ai/sdk)
                              /openai-compatible   OpenAiCompatibleLlmProvider (openai SDK, Telnyx GLM)
packages/workspace          @artemis/workspace   WorkspaceTransport + WorkspaceProcess (files AND processes)
                              /filesystem          FilesystemWorkspaceTransport (local dir + child processes)
packages/storage            @artemis/storage     domain records + repository interfaces + Storage
                              /postgres            PostgresStorage (pg) + Migrator; migrations/*.sql
packages/memory             @artemis/memory      MemoryStore, recallBudget(), transcript/memory rendering
                              /hindsight           HindsightMemoryStore (@vectorize-io/hindsight-client)
packages/tools              @artemis/tools       Tool, Toolset, ToolContext, ToolResult, TOOL_NAMES
                              /workspace-tools     read/write/edit/delete/list/search files + bash (CommandHandoff port)
packages/mcp                @artemis/mcp         settings validation, McpClient, McpCatalog, McpServerRegistry, bridge tools, reminders
                              /sdk                 SdkMcpClient (@modelcontextprotocol/sdk; http, sse, stdio)
packages/agent              @artemis/agent       AgentLoop (stream -> tools -> repeat), oneShot()
services/agent-server       @artemis/agent-server  composition root, API, workers, tasks, delivery, memory, titles, calls
backend/                    (gateway)            auth, devices, voice token, files, utilities, proxy to agent-server
```

Why: each package is one replaceable block with a vendor-free public API; vendor SDKs are imported only by
subpath implementation modules and by `services/agent-server/src/main.ts`. `agent` and `tools` know nothing
about conversations, so they can move into another service unchanged. Dependency direction (no cycles):
`core <- http, llm, workspace, storage, memory`; `llm, workspace <- tools <- mcp`; `llm, tools <- agent`;
everything `<- agent-server`.

### Public APIs (see the source for exact signatures)
| Package | Public surface |
|---|---|
| core | `SerialScheduler.run/drain`, `KeyedRegistry<Reapable>.get/sweep/close`, `Clock`, `Logger`, `AppError`/`NotFoundError`/`ConflictError`/`BusyError`, `prefixedId` |
| http | `eventStream(request, start, opts)`, `readSse(body)`, `hasBearer`, `errorResponse`, `jsonObject` |
| llm | `LlmProvider.stream/complete/modelInfo`, `LlmRequest`, `LlmStreamEvent`, `LlmResponse`, `LlmMessage` (text/image/reasoning/tool_use/tool_result/provider blocks), `ProviderRegistry.resolve`, `parseModelHandle`, `ModelRoute` |
| workspace | `WorkspaceTransport.{stat,readFile,readText,writeFile,deleteFile,makeDirectory,list,glob,grep,spawn,assertWritable}`, `WorkspaceProcess.{exited,output,tail,kill,writeStdin}` |
| storage | `Storage` (all repositories + `transaction`, `migrate`, `healthy`, `close`), records in `domain.ts` |
| memory | `MemoryStore.{ensureReady,retain,recall,healthy}`, `recallBudget`, `formatTranscript`, `renderRecalledMemories` |
| tools | `Tool<I,C>.{definition,parse,execute}`, `Toolset.{definitions,get,execute,with}`, `ToolResult` (+`display`, `task`), `TOOL_NAMES`, `createWorkspaceTools({handoff, backgroundAfterMs})` |
| mcp | `validateMcpServers`, `mcpRevision`, `McpClient`, `McpCatalog.{tools,names,refresh,status}`, `McpServerRegistry.{servers,settings,save,setManaged}`, `createMcpBridgeTools`, `mcpToolsReminder`, `mcpToolsSection` |
| agent | `AgentLoop.run(LoopInput) -> AsyncIterable<LoopEvent>`, `oneShot` |

## 3. Worker model

`WorkerSupervisor` (agent-server) owns all workers. A worker owns an LLM loop or a process; it keeps no state
that cannot be rebuilt from Postgres.

| Worker | Attached to | Born | Dies |
|---|---|---|---|
| `MainAgentWorker` | conversation | lazily: user/voice message, `warm`, waking update | 120 s (`WORKER_IDLE_TIMEOUT_MS`) without activity |
| `SubagentTaskWorker` | task of a conversation | `run_agent` | task end |
| `CommandTaskWorker` | task of a conversation | `bash run_in_background` or foreground handoff | process exit / stop |

States: main `spawning -> idle <-> busy -> stopping -> stopped`; task `spawning -> busy -> stopping -> stopped`; `failed` terminal on spawn error.

Idle reaper: `KeyedRegistry` sweep every 15 s. A main worker is *active* (never reaped) while a turn runs or is
queued, while any task worker of its conversation runs, or while a voice call is active; otherwise it is reaped
when `now - lastActivityAt > 120 s`. Activity = turn start/end, task start/end, call open/close.

Respawn: `supervisor.mainAgent(id)` loads conversation, frozen prompt snapshot, transcript (`messages` where
`task_id IS NULL`, not deleted, by `seq`), `mcp_tool_names_shown`. Held updates are read from storage per turn.

Boot recovery (`supervisor.recover`): `running` turns -> `failed` (`interrupted by restart`) with synthetic
tool results appended for dangling tool_use blocks; `running` tool calls -> `cancelled`; `inflight` updates ->
back to `deliveryFrom`; `running` tasks -> `failed`, report "Interrupted by a server restart" -> normal delivery.

## 4. Turn loop

Per turn (`MainAgentWorker`, serialized by `SerialScheduler`, max 32 pending -> 429 `busy`):

1. Persist `turns` row (running); publish `turn_start`; `memory.conversationActivated(id)` (may flush the previous conversation).
2. Text/update turns claim all `held` updates (token, `inflight`). Voice update turns bring their claimed update.
3. In parallel (bounded): memory recall (§7), MCP reminder diff (`McpCatalog.names()` vs `mcp_tool_names_shown`), image attachments read via `WorkspaceTransport` (<= 5 MB inline).
4. Render the user message (`renderUserTurn`, §6), persist `content` + `envelope`; publish `message` echo (`clientMessageId`).
5. `AgentLoop.run` with the route (§11) and the conversation's frozen system prompt + tool definitions. For each event: `text_delta`/`reasoning_delta` -> `assistant_delta`/`reasoning_delta` (`messageId = <messageId>:<blockIndex>`); `tool_call` -> SSE `tool_call`; `assistant_message` -> persist message + `tool_calls` rows (running) *before* tools run; `tool_result` -> update `tool_calls` (result text, display, task ref) + SSE `tool_result {args, result, isError, display, task}`; `tool_results_message` -> persist. Voice: assistant text goes through `CallStateFilter` to `onText`.
6. End: turn status/usage/model; deliveries `complete` (or `rollback` on failure/cancel); `context_usage`; `turn_end`; `memory.turnCompleted`; on the first user turn of an untitled conversation `titles.request`.

Tool calls of one step run concurrently; results go back in one user message in call order. Unknown tool,
invalid input (ajv against the frozen schema) or a throw -> `isError` result. Max 64 steps per turn.

**Cancellation** (`POST .../cancel`, voice interruption = request abort): abort the stream (partial assistant
message persisted, `stop_reason: aborted`), abort tool signals (foreground bash is killed), append synthetic
`isError` results "Cancelled by the user" for every tool_use without a result, turn `cancelled`,
`turn_end {success:false, error:'aborted'}`. Background tasks are not touched.

**Foreground -> background** (`bash`, interactive policy only): spawn via `WorkspaceTransport.spawn`; race
(exit, `BASH_BACKGROUND_AFTER_MS` = **10 000 ms**, Letta's `DEFAULT_FOREGROUND_YIELD_MS`, abort). On the timer the
tool calls `CommandHandoff.adopt` -> `TaskService` creates the task and the supervisor starts a
`CommandTaskWorker` on the *same* `WorkspaceProcess` (output is buffered from spawn, so nothing is lost); the
tool returns `Command is still running in the background as task <id> (log: <path>). You will get a background
update when it finishes; do not poll.` with `display.background = {taskId, reason:'handoff'}` and
`task = {relation:'backgrounded'}`; the `tool_calls` row becomes `backgrounded`. `run_in_background: true`
adopts immediately (`reason: 'requested'`). Synchronous policy (subagents): wait up to `timeout_ms`
(default 120 s, max 600 s), then kill. Output to the model: <= 30 000 chars, else first 2 000 + log path.

## 5. Tools

One toolset for main agents and subagents (order = `TOOL_NAMES`; append-only to keep caches):
`read_file, write_file, edit_file, delete_file, list_files, search_files, bash, run_agent, list_tasks, get_task,
stop_task, present, set_call_mode, end_call, mcp_describe, mcp_call, mcp_call_write`.

- Writes refuse `data/` (`WorkspaceAccessPolicy.readOnlyPrefixes`); attachments are read-only.
- `run_agent {subagent_type, description, prompt, resume_task_id?}`: interactive -> background task (receipt with
  task id, `display: {type:'agent'}`, `task: {relation:'started'}`); synchronous (inside a subagent) -> runs the
  nested subagent and returns its report. Resume: new task whose transcript starts with the previous task's.
- `list_tasks`, `get_task {task_id}` (status, report, output tail), `stop_task {task_id}`.
- `present`: kept and validated (`shared/present-validation.ts`); advertised only when `ASSISTANT_PRESENT_TOOL=true`
  (default off, as today). `set_call_mode`, `end_call`: always in the list (stable), fail outside calls.
- MCP bridge: `mcp_describe`/`mcp_call`(read-only)/`mcp_call_write`, unchanged semantics; binary results saved
  to `data/artifacts/<conversationId>/...` and returned as `display.artifacts` (replaces the
  `[[mcp-managed-artifacts]]` marker and the backend retention tokens).
- Execution policy is the only difference between main agent (`interactive`) and subagents (`synchronous`).

Subagents (`services/agent-server/prompts/agents/{general-purpose,research}.md`, ported from
`infrastructure/letta/agents`, Letta tool names and the `mcp.sh` wrapper replaced by our tools): full toolset,
system prompt = definition + shared worker rules (synchronous, no detached processes, report conventions,
`NEEDS USER INPUT: <question>` first line -> `needsInput`) + workspace rules + the MCP tool list
(`mcpToolsSection`, names + one-line descriptions) frozen at task start; `worker` model route.

## 6. Prompts and the cached prefix

- **Frozen per conversation**: at `POST /conversations` the agent-server renders `prompts/system.md`
  (`{{name}}`, `{{workspace}}`, `{{conversation_id}}`, `{{timezone}}`) and stores it with the tool definitions in
  `prompt_snapshots` (template id + sha256). Every request of that conversation uses exactly these bytes: later
  template or tool changes apply to new conversations only. A frozen tool that no longer exists in code returns
  an error result.
- Request order: tools -> system -> transcript (stored content replayed verbatim, incl. reasoning signatures and
  compaction blocks; append-only history) -> new user message. Anthropic breakpoints: last tool, system, last
  message. Server-side compaction (`compact-2026-01-12`) handles very long conversations.
- **Per-turn data goes in the user message**, never in the system prompt (format in `turns/envelope.ts`): mode,
  voice reminder, `<current_datetime>`, `<background-update>` blocks, `<attachment/>` tags, MCP reminder diff,
  `<recalled-memories>`, then `<user-content>` + the user's words; images as blocks. The structured envelope
  (`UserTurnEnvelope` v2) is stored next to the rendered content, so the UI never parses prompt text.
- The prompt text drops Letta wording (container, `/root/.letta`, MemFS, reflection) and explains automatic memory.
- Note: switching text <-> voice (thinking on/off) or changing effort invalidates the message cache (not the
  tools/system cache). Acceptable; per-message effort (beta) is a later optimization.

## 7. Memory coordinator (Hindsight)

Single bank `HINDSIGHT_BANK_ID` (default `artemis`), ensured at boot with retain/reflect missions.
Hindsight's own LLM: `claude-haiku-5-5`, `HINDSIGHT_API_LLM_EXTRA_BODY={"output_config":{"effort":"medium"}}`.

- **Last active conversation**: `app_state.last_active_conversation_id`, swapped on every accepted user message
  (text or voice). If the previous value differs and that conversation has unanalyzed completed turns -> flush them.
- **Batch**: after a turn completes, if the conversation has >= 3 (`MEMORY_RETAIN_EVERY`) unanalyzed completed
  *user* turns -> take every unanalyzed completed turn up to and including the 3rd user turn (update turns in
  between are included), create a `memory_retentions` row and mark the turns analyzed in one transaction.
- **Outbox pump** submits pending rows: `retainBatch` one item, `content` = `Speaker (ISO): text` lines
  (User / assistant name / "Background task <title>"), only user-visible text (no tool payloads), `context`
  describing the speakers, `timestamp` = last turn, `document_id = conversation:<id>`, `update_mode: append`,
  `async: true`, `operation_id` = row's uuid (idempotent retries, exponential backoff, terminal after 10 attempts).
- **Recall before every answer** (user, voice and update turns): query = user text (update turns: titles +
  first lines of reports), `budget = recallBudget({modality, effort})` (voice `low`; text low/medium `mid`;
  high/xhigh/max `high`), `max_tokens` low 800 / mid 1500 / high 3000, timeout voice 1.5 s / text 4 s, then
  drop ids already injected (`conversation_recalls`), render `<recalled-memories>` in the envelope, record ids and
  a `turns.recall` trace. Failures/timeouts -> no memories, never a failed turn.
- Removed: persona/human blocks, MemFS, dreaming/reflection, post-call `reflect`, "Memory updated" rows.

## 8. Background task feedback

`TaskWorker` ends -> `tasks` row terminal -> `BackgroundDeliveryService.taskFinished`:
create `background_updates` (`held`, unread) -> SSE `task {finished}`, `updates_changed`, list `unread`.
If `wakesThread(update, task.originMode)` (unchanged policy: never when cancelled or depth > 0; always on
failure/needs-input; success unless started in `voice-short`):
- active call -> `queued` + control-channel `{type:'update', id}`; the voice agent calls
  `POST .../call/updates/:id` (claims queued -> inflight, runs a voice update turn, streams speech) and `ack`;
  call end moves unspoken `queued` back to `held` and wakes the conversation.
- otherwise -> `supervisor.mainAgent(id).submit({kind:'update', modality:'text', effort:'low', text:''})`
  (respawns a reaped worker). The turn claims every held update (held -> inflight -> delivered / rollback).
Non-waking updates stay `held` and ride along with the next turn. Tasks started during a turn that delivers
updates get `depth = depthAfter(updates)`. Read state: `POST .../read`, unread counts, `event` rows in history.

## 9. Titles

`TitleService.request` after the first user turn of an untitled conversation: `oneShot` on the `title` route with
`prompts/title.md` and the first 1 000 chars, 20 s timeout, `cleanTitle`, fallback = first 60 chars;
`setTitleIfUntitled` (a user rename wins); SSE `conversation_updated`. Not stored as a task, never fed to the LLM.

## 10. MCP management

The agent-server owns MCP: `mcp_settings` row (servers, invalid entries, revision = sha256), `McpServerRegistry`
merging manual servers and device-managed servers, `McpCatalog` (TTL 10 min, refreshed on every change),
`SdkMcpClient` (http, sse and stdio — stdio servers are spawned by the agent-server itself). Devices stay in the
gateway: on device connect/disconnect the gateway sends the full managed list to `PUT /v1/mcp/managed`
(`device_<name>` http servers at `${MCP_DEVICE_BASE_URL}/internal/mcp/devices/<name>` with a per-device bearer
header). `McpSettingsResponse.sync` keeps only `catalog` (`skill`/`mod` deprecated, removed with the frontend
update). MCP changes reach conversations as reminder diffs on their next turn.

## 11. Model and effort routing

Handles stay `provider/model`: `ASSISTANT_MODEL=anthropic/claude-haiku-5-5`,
`ASSISTANT_TASK_MODEL=openai-compatible/zai-org/GLM-5.3-Flash` (Telnyx base URL used directly; no proxy, no `/v1`).

| Route | Model | Thinking | Effort | Notes |
|---|---|---|---|---|
| `assistant-text` | ASSISTANT_MODEL | adaptive, `display: summarized` | turn effort (low..max, default medium) | cache + compaction |
| `assistant-voice` | ASSISTANT_MODEL | disabled | medium | allowed on Haiku 5.5 at <= high |
| `update` | ASSISTANT_MODEL | adaptive (text) / disabled (voice) | low / medium | |
| `worker` | ASSISTANT_TASK_MODEL | provider default | `reasoning_effort: high` | never inherits parent settings |
| `title` | ASSISTANT_TITLE_MODEL (default ASSISTANT_MODEL) | disabled | low | maxTokens 64 |

Never send temperature/top_p/top_k to Claude. Parallel tool calls on.

## 12. Storage schema (database `artemis`)

Authoritative DDL: `packages/storage/migrations/0001_initial.sql` (forward-only SQL migrator with
`schema_migrations`, advisory lock, checksum). Tables:

| Table | Purpose / key columns |
|---|---|
| `conversations` | id, title, title_source (auto/user), created/updated/last_message_at, archived_at, mcp_tool_names_shown |
| `prompt_snapshots` | owner_kind (conversation/task), owner_id, system_prompt, tools jsonb, template_id, template_hash |
| `turns` | conversation_id, seq, kind (user/update), modality, mode, effort, status, error, client_message_id, model, usage, recall, started/ended_at, memory_retention_id |
| `messages` | conversation_id, task_id (null = conversation transcript), turn_id, seq, role, content jsonb (exact LLM blocks), envelope, provider, model, provider_message_id, stop_reason, usage, timings, deleted_at |
| `tool_calls` | id (tool_use id), conversation/task/turn, assistant_message_id, name, input, status (running/completed/failed/backgrounded/cancelled), result_text, is_error, display, task_ref, started/ended_at |
| `tasks` | id `task_*`, conversation_id, kind, status, title, prompt, subagent_type, command, cwd, exit_code, stdout/stderr tails, output_path, report, needs_input, origin_mode/turn/tool_call, parent/resumed_from task, depth, model, usage, timestamps, stop_requested_at |
| `background_updates` | task_id (unique), title, status, needs_input, report, duration_ms, depth, delivery, delivery_token/from, delivered_turn_id, unread, timestamps |
| `mcp_settings` | single row: servers, invalid_entries, revision |
| `app_state` | key/value jsonb (`last_active_conversation_id`) |
| `memory_retentions` | outbox: conversation_id, turn_ids, document_id, operation_id, reason, status, attempts, error |
| `conversation_recalls` | (conversation_id, memory_id) injected memories |

Rewind (`DELETE .../messages/:id`) soft-deletes that message and later ones in place (same conversation id;
no fork/archive). Archive = `archived_at`. Start fresh: no Letta import.

## 13. Agent-server API (`/v1`, `Authorization: Bearer AGENT_SERVER_TOKEN`; DTOs in `shared/contracts/agent-server.ts`)

| Method | Route | Response |
|---|---|---|
| GET | `/health`, `/ready` (open) | `AgentServerReadiness` |
| GET/POST | `/v1/conversations` | `ConversationSummary[]` / `ConversationSummary` |
| GET | `/v1/conversations/events` | SSE `ConversationListEvent` |
| GET/PATCH/DELETE | `/v1/conversations/:id` | summary / summary / 204 |
| GET | `/v1/conversations/:id/events` | SSE `ConversationEvent` (snapshot first) |
| GET | `/v1/conversations/:id/messages?before&limit` | `ChatMessage[]` + `X-Next-Cursor` |
| POST | `/v1/conversations/:id/turns` | 202 `TurnAccepted` / 429 |
| POST | `/v1/conversations/:id/cancel` | `CancelResponse` |
| POST | `/v1/conversations/:id/warm` | 204 |
| GET | `/v1/conversations/:id/context-usage` | `ConversationContextUsage \| null` |
| GET | `/v1/conversations/:id/tasks`, `/tasks/:taskId` | `ConversationTask[]` / `ConversationTask` |
| POST | `/v1/conversations/:id/tasks/:taskId/cancel` | `CancelResponse` |
| DELETE | `/v1/conversations/:id/messages/:messageId` | `RewindResponse` |
| POST | `/v1/conversations/:id/read` | `MarkReadResponse` |
| GET/PUT | `/v1/mcp` (PUT with `If-Match`) | `McpSettingsResponse` (412/409 on conflict) |
| PUT | `/v1/mcp/managed` | 204 |
| POST | `/v1/voice/conversations/:id/chat/completions` | SSE `chat.completion.chunk` (model `artemis`) |
| GET | `/v1/voice/conversations/:id/call?mode=` | SSE `CallControlEvent` |
| GET | `/v1/voice/conversations/:id/call/state` | `CallStateResponse` |
| POST | `/v1/voice/conversations/:id/call/updates/:updateId` | SSE spoken text |
| POST | `/v1/voice/conversations/:id/call/updates/:updateId/ack` | 204 |
| POST | `/v1/voice/conversations/:id/ended` | 204 (unspoken updates -> text delivery; no reflection) |

## 14. Gateway (backend/) changes

Keep: `auth.ts`, `http.ts` (or `@artemis/http`), `devices/*`, `routes/files.ts` + `assistant/filesystem/*`
(uploads, workspace serving, upload retention), `routes/utilities.ts`, `link-*`, LiveKit token part of
`routes/voice.ts`. Add `agent-server/client.ts` (`AgentServerClient`: fetch with bearer, streaming passthrough)
and proxy routes: `/api/conversations/**` -> `/v1/conversations/**` (SSE piped, headers `X-Next-Cursor`,
status codes kept; on `POST .../messages` the gateway calls `addAttachmentReferences` then forwards to
`/turns`), `/api/mcp` -> `/v1/mcp`, `/api/voice/conversations/**` -> `/v1/voice/conversations/**`
(`VOICE_GATEWAY_TOKEN` checked by the gateway, `x-voice-call-id` forwarded). `/api/voice/token` stays; it calls
`/v1/conversations/:id` (existence) and `/warm`. Device hub changes -> `PUT /v1/mcp/managed`. `/ready` =
agent-server `/ready`. Delete: `assistant/{runtime*,letta,conversations,background,calls,prompts,tools,present,mcp-context}`,
`internal-tools/`, `mcp/`, `mcp-bridge/`, `routes/letta-callbacks.ts`, Letta deps, `ws`.

## 15. Frontend contract changes

`shared/contracts/chat-types.ts` (done in the skeleton, additive): `TextEffort` + `xhigh|max`;
`ConversationTask` + `subagentType, outputPath, toolCallId, resumedFromTaskId, parentTaskId, needsInput, startedAt, endedAt`;
`ToolTaskRef`, `ToolDisplay`; tool rows and `tool_result` events carry `display?` and `task?`; `task` event
`kind?`; `memory` event kind no longer emitted; MCP `sync.skill/mod` deprecated.
Frontend work: render by our tool names (`TOOL_NAMES`), use `display`/`task` instead of regex parsing (delete
`lib/bash-result.ts`, `lib/command-report.ts`, receipt parsing in `lib/agent-runs.ts`, `letta mcp`/`mcp.sh`
parsing in `tool-display.ts`; `tool-output.ts` uses `display.artifacts`), task grouping by `taskId` /
`resumedFromTaskId`, MCP settings without skill/mod/"Letta container" texts, remove memory rows, comments.

## 16. Docker compose

- `postgres`: `pgvector/pgvector:pg18`, volume `postgres-data`, init script `infrastructure/postgres/init.sql`
  creating roles/databases `artemis` and `hindsight` (+ `CREATE EXTENSION vector` in `hindsight`), healthcheck `pg_isready`.
- `hindsight`: `ghcr.io/vectorize-io/hindsight:1.1.0`, `hostname: hindsight`, `shm_size: 1g`, env per
  hindsight-reference (DB URL to `postgres/hindsight`, Anthropic provider, Haiku 5.5, EXTRA_BODY effort medium,
  API-key tenant extension), python healthcheck on `/health/ready`, internal port 8888 only.
- `agent-server`: `services/agent-server/Dockerfile` — `node:24.19-bookworm-slim`, corepack pnpm 10.18,
  `pnpm install --frozen-lockfile --filter @artemis/agent-server...`, plus the Python tooling from the Letta
  image (`python3 python3-pip python3-venv python3-openpyxl python3-pandas python3-pil python3-matplotlib`) and
  `git curl ripgrep`; user `workspace` (uid 1001) for commands; volumes workspace RW + data; depends on
  postgres (healthy) and hindsight (started); healthcheck `/ready`.
- `backend`: Dockerfile builds from the root workspace (`--filter backend...`); env `AGENT_SERVER_URL=http://agent-server:4000`;
  depends on agent-server healthy. `voice-agent`, `frontend`, `livekit` unchanged.
- Remove `letta`, `openai-compatible-proxy`, `letta-data`; same edits in `docker-compose.{dev,prod,coolify}.yml`
  (dev: `docker compose up -d postgres hindsight livekit`, agent-server/backend/frontend run on the host).

## 17. Environment variables

Added: `DATABASE_URL` (agent-server), `POSTGRES_PASSWORD`, `ARTEMIS_DB_PASSWORD`, `HINDSIGHT_DB_PASSWORD`,
`AGENT_SERVER_URL` (gateway), `AGENT_SERVER_TOKEN` (both), `AGENT_SERVER_PORT=4000`, `HINDSIGHT_URL`,
`HINDSIGHT_API_KEY`, `HINDSIGHT_BANK_ID=artemis`, `ASSISTANT_TITLE_MODEL`, `ASSISTANT_PRESENT_TOOL=false`,
`WORKER_IDLE_TIMEOUT_MS=120000`, `BASH_BACKGROUND_AFTER_MS=10000`, `MEMORY_RETAIN_EVERY=3`.
Kept: `ANTHROPIC_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_API_KEY`, `ASSISTANT_MODEL`,
`ASSISTANT_TASK_MODEL`, `ASSISTANT_NAME`, `ASSISTANT_TIMEZONE`, `WORKSPACE_PATH`, `ASSISTANT_DATA_ROOT`,
`MCP_DEVICE_BASE_URL` (now "reachable by the agent-server"), auth/LiveKit/voice/Groq/Deepgram/IP/ports.
Removed: `LETTA_URL`, `LETTA_SERVER_TOKEN`, `LETTA_AGENT_NAME`, `LETTA_DEFAULT_CONVERSATION_ID`,
`LETTA_DATA_VOLUME`, `LETTA_DATA_EXTERNAL`, `ASSISTANT_GATEWAY_URL`, `OPENAI_COMPATIBLE_PROXY_URL`,
`ASSISTANT_REFLECTION_STEPS`, `LETTA_SKIP_KEYCHAIN_CHECK`, `DISABLE_AUTOUPDATER`.

## 18. Test strategy

- Unit (`tsx --test`, no network): pure functions first — `recallBudget`, `wakesThread`/`depthAfter`,
  `renderUserTurn`, `CallStateFilter`, `projectHistory`, `mcpToolsReminder`, `validateMcpServers`,
  `parseModelHandle`, `cleanTitle`, memory batching selection, provider request/stream mapping with recorded
  SDK event fixtures (no live calls), migrator ordering. Port existing backend tests with the code they cover.
- Component: `AgentLoop` with a scripted fake `LlmProvider` (tool calls, abort, max_tokens); bash handoff with
  `FilesystemWorkspaceTransport` on a temp dir and a 200 ms delay; delivery state machine and supervisor
  (reaper, respawn, recovery) over an in-memory `Storage` fake and fake `Clock`.
- Postgres: repository tests run when `TEST_DATABASE_URL` is set (skipped otherwise); CI uses a pgvector container.
- Contract: gateway proxy tests against a fake agent-server (status, headers, SSE passthrough).
- `scripts/check.mjs`: new group `packages` (typecheck + tests of all workspace packages); remove `letta`,
  `letta-bundle`; `backend` group keeps lint/tests. Smoke: `docker compose up`, send a text turn, run a
  >10 s command, see handoff + update turn, voice call through LiveKit.

## 19. Open questions / assumptions

1. **Voice/call state lives in the agent-server** (call tools, marker filter and delivery need it); the gateway
   keeps LiveKit tokens and proxies the voice-agent endpoints. The voice agent only changes `model="letta"`.
2. **Rewind is in place** (soft delete, same id) instead of fork + archive; already-retained memories are not revoked.
3. **Subagents get the same tools but synchronous**: no background handoff, `run_in_background` refused, nested
   `run_agent` awaited (keeps "the worker's final answer ends the task").
4. `present` stays off by default (current behaviour) behind `ASSISTANT_PRESENT_TOOL`.
5. No explicit memory tool: memories come from automatic retention + recall; explicit "remember/forget"
   requests are retained like any turn (forgetting is not supported by this design).
6. Recalled memories are persisted in the user message (cache-stable); repeats are filtered per conversation.
7. One agent-server instance (in-process event hub, registry); horizontal scaling is out of scope.
8. Upload retention stays a JSON file in the gateway data dir; MCP artifacts move to agent-server-owned
   `data/artifacts/<conversationId>/` deleted with the conversation.
9. Hindsight uses the full image (local embeddings/reranker, ~9 GB) because Anthropic has no embeddings API.
10. `TextEffort` gains `xhigh`/`max` (contract); the UI may keep offering low/medium/high only.
11. Single user/bank; `ASSISTANT_REFLECTION_STEPS` is dropped (no step-count reflection).
