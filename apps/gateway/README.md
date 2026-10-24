# Gateway (`@artemis/gateway`)

The public HTTP edge, on `GATEWAY_PORT` (default 3000). It checks the browser session
(`ARTEMIS_PASSWORD`) and device tokens (`ARTEMIS_DEVICE_TOKEN`). It serves attachments and
workspace files, issues LiveKit tokens, and relays voice routes. It also hosts the device hub and
the device MCP endpoints, and proxies conversation, MCP, and voice requests and their SSE streams
to the agent server.

- Entry point: `src/server.ts`, a Hono app. Composition root: `src/compose.ts`.
- Config and production checks: `src/config.ts`.
- Start: `pnpm --filter @artemis/gateway start`. Dev with watch: `pnpm --filter @artemis/gateway dev`.
- Check: `pnpm check:gateway` (typecheck, ESLint, and tests).
- Container: `apps/gateway/Dockerfile`, which runs `src/server.ts` with Node's
  `--experimental-transform-types` as uid 1001.
- Routes, authentication, and the login and device behaviour: [docs/architecture.md](../../docs/architecture.md#routes)
  and [docs/deployment.md](../../docs/deployment.md#login-and-device-limits).
