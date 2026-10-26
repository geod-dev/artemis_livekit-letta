# @artemis/http

HTTP helpers shared by `apps/gateway` and `apps/agent-server`:

- `auth.ts`: bearer-token authentication.
- `errors.ts`: the error response shape.
- `sse-server.ts`: the server side of an SSE stream.
- `sse-client.ts`: an SSE client parser.

- **Entry point:** `src/index.ts`.
- **Depends on:** `@artemis/core`.
- **Check:** `pnpm check:packages`.
