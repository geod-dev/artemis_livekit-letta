# Persistent assistant

A personal assistant with one identity and Hindsight-backed memory, shared across text
chat, voice calls, and background work. The repository holds the web app, the gateway,
the agent server, the LiveKit voice agent, the desktop device client, the Android
WebView wrapper, and the deployment files.

## Layout

| Path | Contents |
|---|---|
| `apps/` | Deployable entry points: `web`, `gateway`, `agent-server`, `voice-agent`, `device-client`, `mobile`. |
| `packages/` | Libraries (`@artemis/*`) imported by the Node apps. Packages never import apps. |
| `deploy/` | Coolify poller and token rotation, the standalone HTTPS setup, and the Postgres image. |
| `scripts/` | Repository tooling: `check.mjs` (checks) and `check-boundaries.mjs` (dependency rules). |
| `docs/` | Architecture, development, deployment, provider, and frontend design notes. |
| `data/` | Gitignored runtime data created on the host (`data/workspace`, `data/gateway`). |

The Compose files (`docker-compose*.yml`) sit at the repository root.

## Setup

Requirements: Node 24.19.0, pnpm 10.18.0, `uv` for the Python apps, and Docker with
Compose v2. Full details are in [Development](docs/development.md).

```sh
pnpm install
cp .env.example .env   # then replace every placeholder value
```

## Run

- **Development:** start Postgres, Hindsight, and LiveKit in Docker, then run each app on
  the host. See [Development](docs/development.md).
- **Full stack in Docker:** `docker compose up -d --build`. For production, add
  `-f docker-compose.prod.yml` and set the production values listed in
  [Deployment](docs/deployment.md).

## Checks

`pnpm check` runs every check group from the repository root. Each group can also run
alone with `pnpm check:<group>`:

| Group | What it covers |
|---|---|
| `gateway` | Typecheck, lint, tests for `apps/gateway` |
| `agent-server` | Typecheck and tests for `apps/agent-server` |
| `web` | Typecheck, lint, tests for `apps/web` |
| `voice` | Pytest, ruff, and pyright for `apps/voice-agent` |
| `device` | Unit tests for `apps/device-client` |
| `packages` | Typecheck and tests for every `packages/*` workspace package |
| `deploy` | Mocked tests for the Coolify scripts in `deploy/coolify` |
| `schema` | Drift check for the generated present-tool schema |
| `boundaries` | Dependency rules and the checker's self-test |

## Documentation

- [Architecture](docs/architecture.md): the apps, packages, dependency rules, runtime data, and how the services talk.
- [Development](docs/development.md): prerequisites, running each app, checks, and tests.
- [Deployment](docs/deployment.md): Compose files, required settings, HTTPS, Postgres init, and Coolify.
- [Providers](docs/providers.md): model, worker, memory, and speech provider configuration.
- [Frontend design](docs/frontend-design.md): visual system notes for the web app.
- [Connected devices](apps/device-client/README.md): the optional device bridge.
- [Android app](apps/mobile/README.md): building and installing the WebView wrapper.
