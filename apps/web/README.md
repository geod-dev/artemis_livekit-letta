# Web app (`@artemis/web`)

The browser client: a Vite React single-page app with the chat, composer, voice-call controls,
settings, and workspace panel. The production build is static files, served by nginx
(`nginx.conf`) in the unprivileged nginx image, on port 8080 in the container. nginx sends `/api`
and `/health` to the gateway and `/livekit/` to LiveKit.

- Entry point: `index.html`, which loads `src/main.tsx`.
- Dev server: `pnpm --filter @artemis/web dev`, at http://127.0.0.1:5173. It proxies `/api` to
  `GATEWAY_URL`, or to `http://$IP_ADDRESS:3000`.
- Build: `pnpm --filter @artemis/web build`.
- Check: `pnpm check:web`. It runs the typecheck (app, Node config, and tests), the Prettier format
  check, ESLint, and the tests. The tests run with tsx, like the other TypeScript apps.
- Imports: this app may import only `@artemis/contracts` from the workspace. The boundary checker
  denies Node built-in modules and server-only npm SDKs in `src`, so server code stays out of the
  browser bundle.
- Generative UI: `src/lib/present-library.ts` defines the `present` tool. After changing it,
  run `pnpm generate:present-tool` from the repo root.
- Code layout and visual system: [docs/frontend-design.md](../../docs/frontend-design.md).
- Container: `apps/web/Dockerfile`.
