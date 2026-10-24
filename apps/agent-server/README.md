# Agent server (`@artemis/agent-server`)

The service that owns conversations. It handles turns, the event streams (SSE), background
tasks and subagents, tools, the MCP registry, memory retention and recall through Hindsight,
titles, and call state. It serves a bearer-protected `/v1` API on `AGENT_SERVER_PORT` (default
4000) and applies its database migrations at startup.

- Entry point: `src/main.ts`. Composition root, which selects the vendor packages:
  `src/compose.ts`.
- Prompt templates bundled into the image: `templates/` (`system.md`, `title.md`,
  `worker-rules.md`, and `agents/`). The renderer that fills them is `src/prompts/`.
- Start: `pnpm --filter @artemis/agent-server start`. Dev with watch:
  `pnpm --filter @artemis/agent-server dev`.
- Check: `pnpm check:agent-server` (typecheck and tests). This app has no lint step.
- Live smoke test against a running server: `pnpm smoke:agent-server`. It is not part of
  `pnpm check`.
- Container: `apps/agent-server/Dockerfile`. It runs as uid 1001 and starts with a `umask 0002`,
  so the files it creates in the workspace stay group-writable for the agent.
- Architecture and dependency rules: [docs/architecture.md](../../docs/architecture.md).
