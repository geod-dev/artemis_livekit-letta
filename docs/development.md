# Development

## Prerequisites

- **Node.js 24.19.0** (`.node-version`, `engines` in the root `package.json`).
- **pnpm 10.18.0** (`packageManager` in the root `package.json`; use Corepack or install it directly).
- **uv** for the Python apps and checks. The device client and deployment tests run on
  Python 3.13 through `uv run --python 3.13`. The voice agent pins 3.13 in
  `apps/voice-agent/.python-version` and supports `>=3.11, <3.15`.
- **Docker with Compose v2** for Postgres, Hindsight, and LiveKit.
- **Java 17 and Android SDK 35**, only for building the Android app.

## Install

From the repository root:

```sh
pnpm install            # one workspace and one lockfile for every Node package, including apps/web
cd apps/voice-agent && uv sync && cd -
cp .env.example .env    # then set real local values
```

The device client has no dependencies to install. Keep `.env` local; it is gitignored.

## Supporting services

Postgres, Hindsight, and LiveKit run in Docker, and the apps run on the host. Start the
three services with the base and dev Compose files:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres hindsight livekit
```

The dev override publishes Postgres on `127.0.0.1:5432` and Hindsight on
`127.0.0.1:8888`. Compose refuses to start without the required passwords and keys (see
[Deployment](deployment.md#required-settings)).

## Running the apps on the host

Set these in `.env` for host runs:

- `DATABASE_URL` pointing at `127.0.0.1:5432`, database `artemis`, with the same
  `ARTEMIS_DB_PASSWORD` used by Compose.
- `HINDSIGHT_URL=http://127.0.0.1:8888`.
- `AGENT_SERVER_TOKEN`, `AGENT_SERVER_URL=http://127.0.0.1:4000`.
- `GATEWAY_URL` and `MCP_DEVICE_BASE_URL=http://127.0.0.1:3000`.

Run each app in its own terminal:

| App | Command | Address |
|---|---|---|
| Agent server | `pnpm --filter @artemis/agent-server dev` | port 4000 |
| Gateway | `pnpm --filter @artemis/gateway dev` | port 3000 |
| Web | `pnpm --filter @artemis/frontend dev` | http://127.0.0.1:5173 |
| Voice agent | `cd apps/voice-agent && uv run agent dev` | LiveKit worker |
| Device client | `python apps/device-client/artemis-device.py <device-name>` | see its [README](../apps/device-client/README.md) |

The agent server applies its database migrations at startup. Use `start` instead of `dev`
for a single run without watch mode. The web dev server proxies `/api` to `GATEWAY_URL`
(or `http://$IP_ADDRESS:3000`). To test from another device, set `IP_ADDRESS` to the
host's LAN address and `LIVEKIT_SIGNAL_BIND` to a matching bind address.

## Checks

Run every check group from the repository root:

```sh
pnpm check
```

Run one group with `pnpm check:<group>`. The groups are `gateway`, `agent-server`, `web`,
`voice`, `device`, `packages`, `deploy`, `schema`, and `boundaries`. Their contents are
listed in the [README](../README.md#checks).

Notes:

- The `packages` group runs typecheck and tests for every `packages/*` workspace package.
- The `schema` group fails if `packages/contracts/generated/present-tool.json` has drifted
  from its generator. Regenerate it with `pnpm generate:present-tool`.
- Postgres integration tests run only when `TEST_DATABASE_URL` is set to a database the
  tests may create tables in. Without it, `pnpm check` prints a warning and skips them.
- `pnpm smoke:agent-server` runs a live turn against an already-running agent server. It is
  not part of `pnpm check`.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. It has two jobs:

- `check` runs `pnpm install --frozen-lockfile` and `pnpm check`. It uses Node from
  `.node-version`, pnpm from `packageManager`, and uv with Python 3.13. A pgvector Postgres
  service container sets `TEST_DATABASE_URL`, so the Postgres integration tests run.
- `compose` validates `docker-compose.yml`, `docker-compose.dev.yml` and
  `docker-compose.coolify.yml` with placeholder values, then builds the `gateway`,
  `agent-server`, `frontend` and `voice-agent` images.

CI does not need Java. The Android build (Java 17) is not part of CI. CI does not deploy or
publish anything.

## Where tests live

- `apps/gateway/src/**/*.test.ts`, `apps/agent-server/src/**/*.test.ts`, and
  `apps/web/src/**/*.test.ts`, run by their app's check group.
- `packages/*/src/**/*.test.ts`, run by the `packages` group. Postgres tests are in
  `packages/storage/src/vendor/postgres/`.
- `apps/voice-agent/tests/`, run with pytest through `uv`.
- `apps/device-client/tests/test_device.py`, run by the `device` group.
- `deploy/coolify/test_*.py`, run by the `deploy` group with mocked API responses. They do
  not contact Coolify.
- `scripts/check-boundaries.mjs --self-test`, run by the `boundaries` group.

## Android build

Build the debug APK from the repository root. Every build needs an HTTPS origin:

```powershell
.\apps\mobile\gradlew.bat -p apps\mobile -PartemisUrl=https://your-host assembleDebug
```

The output is `apps/mobile/app/build/outputs/apk/debug/app-debug.apk`.
`apps/mobile/scripts/install-android.ps1` installs that APK by default; pass `-ApkPath` to
install another file. The app's microphone permission, authenticated downloads, and
same-site previews all depend on this origin. See [its README](../apps/mobile/README.md).

Signing keys under `apps/mobile/.signing/` and build outputs are gitignored. Keep your
debug keystore between builds if you want to install updates without uninstalling.
