# Artemis

A personal assistant with one identity and Hindsight-backed memory, shared across text
chat, voice calls, and background work. The repository holds the web app, the gateway,
the agent server, the LiveKit voice agent, the desktop device client, the Android
WebView wrapper, and the deployment files.

## Naming

The public name is **Artemis**. The repository is named `livekit-letta`. Some identifiers
keep the Artemis name on purpose, because renaming them would change deployed paths and
units without changing behaviour:

- the `@artemis/*` package scope and the root package name `artemis`
- the `ARTEMIS_*` environment variables
- the host paths under `/data/artemis` and the systemd units `artemis-*`
- the Android project `ArtemisMobile` and its package `ai.artemis.mobile`

## Layout

| Path | Contents |
|---|---|
| `apps/` | Deployable entry points: `web`, `gateway`, `agent-server`, `voice-agent`, `device-client`, `mobile`. Apps never import each other. |
| `packages/` | Node libraries under the `@artemis/*` scope, imported by the apps. Packages never import apps. |
| `deploy/` | Coolify poller and token rotation, the standalone HTTPS setup, and the Postgres image. |
| `scripts/` | Repository tooling: `check.mjs` (check groups), `check-boundaries.mjs` (dependency rules), `generate-present-tool.ts` (present-tool schema), and `smoke-agent-server.mjs` (live smoke test). |
| `docs/` | Architecture, development, deployment, provider, and visual design notes. |
| `data/` | Gitignored runtime data created on the host (`data/workspace`, `data/gateway`). |

The Compose files (`docker-compose*.yml`) sit at the repository root.

## Setup

Requirements: Node 24.19.0, pnpm 10.18.0, `uv` for the Python apps, and Docker with
Compose v2. Java 17 and the Android SDK are needed only for the Android app. Full details
are in [Development](docs/development.md).

```sh
pnpm install
cp .env.example .env   # then replace every placeholder value
```

## Run

- **Development:** start Postgres, Hindsight, and LiveKit in Docker, then run each app on
  the host. See [Development](docs/development.md).
- **Full stack in Docker:** `docker compose up -d --build`. For a standalone production
  host, add `-f docker-compose.prod.yml` and set the production values listed in
  [Deployment](docs/deployment.md).

## Checks

`pnpm check` runs every check group from the repository root. Each group can also run
alone with `pnpm check:<group>`:

| Group | What it covers |
|---|---|
| `gateway` | Typecheck, ESLint, and tests for `apps/gateway` |
| `agent-server` | Typecheck and tests for `apps/agent-server` |
| `web` | Typecheck (app, Node config, and tests), Prettier format check, ESLint, and tests for `apps/web` |
| `voice-agent` | Pytest, ruff, and pyright for `apps/voice-agent` |
| `device-client` | Ruff and unit tests for `apps/device-client` |
| `mobile` | Debug APK build, JVM unit tests and lint for `apps/mobile`. Needs JDK 17 and the Android SDK; without a JDK the group fails unless `CHECK_SKIP_MOBILE=1` is set |
| `packages` | Typecheck and tests for every `packages/*` workspace package |
| `deploy` | Mocked tests for the Coolify scripts, and syntax checks of the shell scripts in `deploy/` |
| `schema` | Drift check for the generated present-tool schema, and typecheck of the generator |
| `boundaries` | Dependency rules and the checker's self-test |

`CHECK_SKIP_MOBILE=1` skips the `mobile` group's steps with a warning when no JDK is on `PATH`. Set it
in the shell that runs `pnpm check`; `scripts/check.mjs` does not read `.env`. A run with it does not
build or test the Android app.

## Documentation

- [Architecture](docs/architecture.md): the apps, packages, dependency rules, routes, runtime data, and how the services talk.
- [Development](docs/development.md): prerequisites, running each app, checks, and tests.
- [Deployment](docs/deployment.md): Compose files, required settings, runtime data ownership, HTTPS, Postgres, and Coolify.
- [Providers](docs/providers.md): model, worker, memory, and speech provider configuration.
- [Web app design](docs/frontend-design.md): visual system and component layout of the web app.
- [Connected devices](apps/device-client/README.md): the optional device bridge.
- [Android app](apps/mobile/README.md): building and installing the WebView wrapper.
