# Migration work packages

Design: [architecture.md](architecture.md). Contracts skeleton is committed: implement against it; change a
contract only in your own package (report cross-package changes instead of editing other packages).

## Ground rules (all packages)

- **Dependencies/lockfile**: every dependency is already declared and installed. Parallel packages must NOT run
  `pnpm add`/`pnpm install` and must not edit any `package.json` or `pnpm-lock.yaml`. If one is truly needed,
  report it; WP-13 (sequential, last) applies it. Exception: WP-13 owns the root `package.json`,
  `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `backend/package.json`.
- `shared/contracts/*` is frozen; only WP-12 may adjust frontend-only comments there, and WP-13 removes deprecated fields.
- Every package: `pnpm --filter <pkg> typecheck` and `pnpm --filter <pkg> test` green; ESM, `.ts` import
  suffixes, no vendor SDK imports outside the listed implementation modules; port existing tests where code is ported.
- Global gates: `pnpm typecheck:packages`, `pnpm test:packages`, `pnpm check:backend`, `pnpm check:frontend`.

## Packages

| ID | Title | Owns (exclusive) | Deps | Group |
|---|---|---|---|---|
| WP-01 | Core + HTTP blocks | `packages/core/src`, `packages/http/src` | - | A |
| WP-02 | LLM providers | `packages/llm/src` | - | A |
| WP-03 | Storage (Postgres + in-memory fake) | `packages/storage/{src,migrations}` | - | A |
| WP-04 | Workspace transport + workspace tools | `packages/workspace/src`, `packages/tools/src` | - | A |
| WP-05 | Hindsight memory store | `packages/memory/src` | - | A |
| WP-06 | MCP package | `packages/mcp/src` | - (codes against WP-04 contracts) | A |
| WP-07 | Agent loop | `packages/agent/src` | - (fake provider/toolset in tests) | A |
| WP-11 | Gateway (backend) | `backend/src`, `backend/prompts` (delete) | - | A |
| WP-12 | Frontend structured tools/tasks | `frontend/src`, `frontend/scripts` | - | A |
| WP-08 | Agent-server foundation | `services/agent-server/{prompts,src/config.ts,src/models,src/prompts,src/subagents,src/events,src/conversations,src/titles,src/main.ts,src/migrate.ts}` | A packages | B |
| WP-09 | Workers, turns, tasks, tools, delivery | `services/agent-server/src/{workers,turns,tasks,tools,background}` | A packages | B |
| WP-10 | Memory coordinator, calls, HTTP API | `services/agent-server/src/{memory,calls,api}` | A packages | B |
| WP-13 | Infra, cleanup, docs, checks | compose files, `infrastructure/**`, `services/agent-server/Dockerfile`, `backend/Dockerfile`, `.env.example`, `scripts/check.mjs`, root/backend `package.json`, lockfile, `docs/*.md`, `README.md`, `devices/README.md`, `agent/` strings | all | C |

Group A runs in parallel (9 agents). Group B (3 agents in parallel) starts when A's packages they use are merged;
B agents may use in-memory fakes from WP-03 and scripted fakes for anything missing. C runs alone at the end.

## Details and acceptance

**WP-01** Implement `SerialScheduler` (port `backend/src/assistant/runtime/scheduler.ts`), `KeyedRegistry`
(port `runtime/registry.ts`: single-flight create, tombstones, sweep with `Clock`), `consoleLogger`,
`eventStream` (port `backend/src/http.ts`), `readSse`, `hasBearer` (timing-safe), `errorResponse`, `jsonObject`.
Accept: tests for scheduler limits/order, registry reap/respawn/tombstone with a fake clock, SSE framing + parser round trip.

**WP-02** `parseModelHandle`, `ProviderRegistry`, `AnthropicLlmProvider` (`client.messages.stream`, adaptive /
disabled thinking with `display`, `output_config.effort`, cache breakpoints, compaction beta, `eager_input_streaming`,
reasoning signatures + provider blocks round trip, typed error mapping, abort -> `aborted` message_end),
`OpenAiCompatibleLlmProvider` (Telnyx base URL as-is, `reasoning_effort`, `reasoning_content`, tool calls
streaming, images). `modelInfo` static tables (Haiku 5.5: 1M ctx, 128k out). Accept: mapping tests with
recorded SDK event fixtures; no network in tests.

**WP-03** `PostgresStorage` (pg Pool, repositories exactly as `repositories.ts`, transactions, `Migrator`
with advisory lock + checksums, `migrations/0001_initial.sql` may be refined but stays the single initial file),
plus `src/memory/InMemoryStorage` (same semantics, for other packages' tests; export subpath `./memory` is
added by WP-13 — meanwhile import by relative path is not allowed, so expose it from `src/index.ts` as
`InMemoryStorage`). Accept: unit tests on the fake; Postgres tests gated on `TEST_DATABASE_URL`.

**WP-04** `FilesystemWorkspaceTransport` (containment incl. symlinks, atomic writes, `fs.glob`, grep via
`rg` when present else JS fallback, `spawn` with process groups, `runAs`, buffered replayable output, kill
TERM->KILL), `Tool.parse` (ajv), `Toolset`, `createWorkspaceTools` (7 tools, bash handoff semantics of
architecture.md §4, 30k cap, `display` filled). Accept: temp-dir tests; bash handoff test with
`backgroundAfterMs: 200`, adoption keeps output; synchronous policy timeout.

**WP-05** `HindsightMemoryStore` (client 1.1.0: bank ensure with missions, `retainBatch` async append with
operation id, `recall` mapping to `MemoryFact`), `formatTranscript`, `renderRecalledMemories`. Accept: tests with
a fake fetch / client stub; `recallBudget` tests stay green.

**WP-06** Port `backend/src/mcp/settings.ts` validation (without Letta file format), `mcpRevision`, `SdkMcpClient`
(port `mcp-bridge/client.ts` + stdio transport + artifacts through `ArtifactSink`), `McpCatalog`
(port), `McpServerRegistry` (manual + managed, CAS save), `createMcpBridgeTools` (port specs/handlers as `Tool`s
with `display.mcp`), `mcpToolsReminder` (port), `mcpToolsSection`. Accept: ported tests from `backend/src/mcp*/**.test.ts`.

**WP-07** `AgentLoop` (architecture.md §4: streaming events, persist-before-execute ordering via events,
concurrent tools, ordered results, abort with synthetic results, max steps, refusal/max_tokens), `oneShot`.
Accept: scripted fake provider tests: multi-step tools, parallel calls, abort mid-stream and mid-tool.

**WP-08** `loadConfig` (env table in architecture.md §17), `createModelRouter` (§11), `PromptRenderer`
+ `prompts/system.md` (from `backend/prompts/system.md`, Letta wording removed, tool names updated, memory
section rewritten), `prompts/title.md`, `prompts/agents/{general-purpose,research}.md` + shared worker rules
(ported from `infrastructure/letta/agents`), `loadSubagentDefinitions`, `needsUserInput`, `ConversationEventHub`
(port events.ts), `ConversationService` + `projectHistory`, `TitleService` + `cleanTitle`/`fallbackTitle` (port),
`main.ts` composition root + graceful shutdown, `migrate.ts`. Accept: router table tests, renderer freeze test,
history projection tests, title tests.

**WP-09** `MainAgentWorker` (turn sequence §4), `SubagentTaskWorker`, `CommandTaskWorker`,
`WorkerSupervisor` (reaper 120 s with activity rules, respawn, `recover`), `renderUserTurn` + `CallStateFilter`
(port), `TaskService` (incl. `CommandHandoff.adopt`, subagent start/run/resume, list/get/stop projections),
`createAgentToolset` (task tools, `run_agent`, `present`, call tools; ordering = `TOOL_NAMES`),
`BackgroundDeliveryService` (§8). Accept: tests with InMemoryStorage, fake provider, temp workspace: text turn,
cancel, handoff -> task -> update turn wakes a reaped worker, voice-short success stays held, depth limit, recovery.

**WP-10** `MemoryCoordinator` (§7: last-active swap + flush, batch of 3, outbox with retries, recall with timeout
and dedup), `CallSessions` (port calls/state.ts + voice-input.ts), Hono API (§13, incl. OpenAI-compatible voice
stream and call routes, error mapping, SSE). Accept: coordinator tests with fake `MemoryStore` + fake clock
(3-turn batching, switch flush, timeout), API tests with `app.request()` and stubbed services.

**WP-11** Gateway per architecture.md §14: `AgentServerClient`, proxy routes, device -> `PUT /v1/mcp/managed`,
voice token + warm, `/ready`, config (drop Letta vars, add `AGENT_SERVER_URL/TOKEN`), delete Letta-coupled
modules and their tests. Do not edit `backend/package.json` (WP-13 removes deps). Accept: `pnpm check:backend`
green; proxy tests against a fake agent-server.

**WP-12** Frontend per architecture.md §15: tool names, structured `display`/`task`, delete regex parsers and
their tests, task grouping, MCP settings simplification, memory rows removed, Letta comments.
Accept: `pnpm check:frontend` green.

**WP-13** Compose (4 files) per §16, `infrastructure/postgres/init.sql`, `services/agent-server/Dockerfile`,
backend Dockerfile on the root workspace, delete `infrastructure/letta`, `infrastructure/openai-compatible-proxy`,
`backend/pnpm-lock.yaml`; `.env.example` per §17; `scripts/check.mjs` (+`packages` group, - `letta*`) and root
scripts; remove Letta deps from `backend/package.json` and `onlyBuiltDependencies` entry, add `./memory` subpath
if needed, `pnpm install`; remove deprecated contract fields; docs (`README.md`, `docs/architecture.md`,
`providers.md`, `development.md`, `deployment.md`, `devices/README.md`, Coolify README); `agent/` model string
`artemis` and docstrings. Accept: `pnpm check` green; `grep -ri letta` finds only `docs/migration-hindsight/` and
historical `CODE_REVIEW.md`/`FIX_ORCHESTRATION.md` (or those are deleted); `docker compose config` valid.
