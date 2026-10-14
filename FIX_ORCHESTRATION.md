# Review remediation report

Source: `CODE_REVIEW.md`, 87 findings (F01–F15, M01–M12, B01–B27, U01–U15, O01–O11, D01–D07). The original review remains a record of the starting state.

## Orchestration

Researched the official [Codex subagent guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents) before assigning implementation work. Used 18 agents on `gpt-6-luna`, with fresh task-only contexts and concise reports. Workers were instructed never to read the review or this report. Each assignment covered at most 25 findings. Up to three workers ran concurrently; assignments involving the same files ran sequentially. Existing agents were reused for related follow-ups.

Correctness and interface changes preceded dependent integration and file moves. The coordinator handled shared wiring, reviewed reports, and assigned focused follow-ups where initial fixes left gaps. No commits, deployment, phone installation, or live credential changes were performed.

## Coverage

Cross-cutting findings appear in multiple rows because they required changes on both sides of an interface.

| Assignment | Findings | Result |
|---|---|---|
| Runtime lifecycle | B06–B12, M03 | Terminal reader state, bounded scheduling/buffers, cancellation/draining, idle errors, retryable claims, title guards and initialization cleanup. |
| Background delivery | B02–B05, M01 | Versioned validated storage, durable serialized transactions, delivery claims/completion/rollback and unresolved-result retention. |
| Python voice | O05–O06, voice B02 | Supervised tasks/timers, detachable handlers, operation deadlines, stalled-stream watchdog, decoding and delivery retry state. |
| Device client and hub | F03, F13, M08, O01–O04, device D06 | Importable CLI package, separate API/hub/adapters, typed scopes, independent heartbeat, bounded RPC/transport lifecycle and pagination. |
| HTTP/conversation integration | B01, B09–B11, B13–B17, backend U01/U03, M11 | Validated owner-guarded requests, client identities, active snapshots, cursor history, explicit default identity and safe errors. |
| Frontend state/API | M06, M10, U01–U07, U10, auth D06 | Conversation reducer, validated API/events, reconnect reconciliation, stable merging, owner-bound actions and acknowledged mutations. |
| MCP/settings | B22–B25, U05/U06/U09, M11, MCP D07 | Diagnostic versus operational settings, revision conflicts, saved/sync status and retry, bounded catalog/deadlines, lossless envelopes and validated argument editing. |
| Build tooling/contracts | F06–F07, F11 | Root pinned aggregate checks, repaired package resolution, shared API contracts and generated schemas with drift checks. |
| Backend lifecycle | F12, M01–M03, B24/B26 | Explicit configuration/start/close, injected delivery ports, extracted runtime responsibilities, readiness and external production data roots. |
| Workspace backend | B18–B21, B25, M12, docs D06, link D07 | Bounded upload/recording/transcription, authoritative MIME, range/HEAD serving, attachment ownership and versioned history codecs. |
| Android/deployment/docs | F08–F10, F14–F15, M08, O07–O11, docs D06 | Current-build installer, ignored artifacts/private state, configured HTTPS mobile identity, authenticated previews/downloads, base Compose plus overrides, safe health setup, revision/token recovery and provider compatibility. |
| Tool UI | M05, M12, U15, D04 | Supported renderers and pure helpers extracted; unreachable approval/question framework removed. |
| Media UI | M07, U08, U13–U15 | Bounded retryable metadata caches, invalidation, accessible dialogs, lazy actual-link previews, opt-in icons and owned pure helpers. |
| Chat layout/styles | M04, M07, M09, U11–U12, D01–D03/D05 | Short thread composition, separated message/composer responsibilities and styles, activity-only animation, cached waveform geometry and unused branches removed. |
| Generative UI validation | B27, M11–M12 | Generated component prop schemas, bounded trees/actions/URLs, boundary validation and recoverable rendering fallback. |
| Backend boundaries | F01–F02, M11, final B16/B19 audit | Conversation/call/background domains, named SDK/filesystem adapters and unified Letta infrastructure. Complete traversal or explicit error; generated outputs protected across recovery gaps. |
| Frontend boundaries | F04–F05 | Chat/composer/tools/files/markdown/shared folders, ordinary application filenames and distinct reasoning adapter/disclosure names. |
| Delivery/lifecycle audit | B02, B15 | Durable source-to-fork callback routing, terminal callback acceptance, recoverable partial-fork responses and supervised voice delivery retries. |

## Checks and limitations

- Aggregate checks: backend and frontend type/lint checks, Python Ruff/Pyright, device checks, Letta extensions, pinned upstream bundle compatibility, mocked deployment/token recovery, and both generated-schema drift checks.
- Final checks: 277 tests passed across backend (141), frontend (75), voice (19), devices (20), Letta extensions (11), pinned bundle (4) and operations (7). Voice lint/type issues encountered in the aggregate run were corrected and its complete checks rerun successfully.
- After the final B16/B19 follow-up, backend typecheck, lint and all 141 tests passed again.
- Frontend production build passed after the file moves. Build reports existing chunk-size and dependency annotation warnings.
- Android Java compilation against SDK 35, configuration/installer parsing and Compose validation passed. Full Android Gradle build remains unverified because the local Gradle daemon connection fails, including outside the sandbox.
- Local checks used filesystem/loopback escalation where required. Live deployment, microphone/WebRTC sessions and physical Android/device behavior were not exercised.

## Operational notes

Existing data is not moved automatically. Follow `docs/deployment.md` before changing workspace/data roots. Android builds now require a configured HTTPS origin. Explicit default-conversation configuration replaces oldest-conversation inference. Generated outputs are retained for deliberate cleanup; abandoned uploads expire after 24 hours. Exhausted or cyclic internal provider traversal fails explicitly rather than returning partial results.

