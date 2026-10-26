# Development

## Prerequisites

- **Node.js 24.19.0** (`.node-version`, `engines` in the root `package.json`).
- **pnpm 10.18.0** (`packageManager` in the root `package.json`; use Corepack or install it directly).
- **uv** for the Python apps and checks. The device client and the deployment tests run on
  Python 3.13 through `uv run --python 3.13`. The voice agent pins 3.13 in
  `apps/voice-agent/.python-version` and requires `>=3.13`.
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

Postgres, Hindsight, and LiveKit run in Docker, and the apps run on the host. Start the three
services with the base and dev Compose files:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres hindsight livekit
```

The dev override publishes Postgres on `127.0.0.1:5432` and Hindsight on `127.0.0.1:8888`.
Compose refuses to start without the required passwords and keys (see
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
| Web | `pnpm --filter @artemis/web dev` | http://127.0.0.1:5173 |
| Voice agent | `cd apps/voice-agent && uv run voice-agent dev` | LiveKit worker |
| Device client | `python apps/device-client/artemis-device.py <device-name>` | see its [README](../apps/device-client/README.md) |

The agent server applies its database migrations at startup. Use `start` instead of `dev` for a
single run without watch mode. The gateway's `start` script runs Node with
`--experimental-transform-types`, as its container does. The web dev server proxies `/api` to `GATEWAY_URL` (or `http://$IP_ADDRESS:3000`).
To test from another device, set `IP_ADDRESS` to the host's LAN address and `LIVEKIT_SIGNAL_BIND`
to a matching bind address.

The voice agent reads the env file named by `VOICE_ENV_FILE`, or the repository-root `.env` when
that variable is unset. Its `GATEWAY_URL` must be HTTPS unless it is loopback, so a LAN gateway needs
HTTPS. The device client needs `--server https://...` for any non-loopback gateway.

## Checks

Run every check group from the repository root:

```sh
pnpm check
```

Run one group with `pnpm check:<group>`. The groups are `gateway`, `agent-server`, `web`, `voice`,
`device-client`, `mobile`, `packages`, `deploy`, `schema`, and `boundaries`. Their contents are
listed in the [README](../README.md#checks).

Notes:

- The `web` group runs `tsc` for the app, its Node config, and its tests (`tsconfig.test.json`), then
  the Prettier format check, ESLint, and the tests.
- The `mobile` group needs a JDK and the Android SDK. Without a JDK, each of its steps is skipped with
  a message, not failed.
- The `packages` group runs typecheck and tests for every `packages/*` workspace package.
- The `schema` group fails if `packages/contracts/generated/present-tool.json` has drifted from its
  generator. Regenerate it with `pnpm generate:present-tool`.
- Postgres integration tests run only when `TEST_DATABASE_URL` is set to a Postgres server admin URL.
  The suites create and drop their own databases, so use a throwaway server. Without it, `pnpm check`
  prints a warning and skips them.
- `pnpm smoke:agent-server` runs a live turn against an already-running agent server. It is not part
  of `pnpm check`.

## Test runners

- **TypeScript packages and apps** (`packages/*`, `apps/gateway`, `apps/agent-server`, `apps/web`) run
  `tsx --test "src/**/*.test.ts"`. tsx resolves the `@/` path alias in `apps/web`, so the web tests use
  the same runner as the other TypeScript code.
- **`apps/voice-agent`** runs pytest through `uv run --locked`.
- **Python device client and deployment scripts** run `unittest` with the pattern `test_*.py`.
- **The boundary checker** runs its own self-test (`scripts/check-boundaries.mjs --self-test`).

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. It has two jobs:

- `check` runs `pnpm install --frozen-lockfile` and `pnpm check`. It sets up Node from `.node-version`,
  pnpm from `packageManager`, uv 0.7.22 with the Python version from `apps/voice-agent/.python-version`,
  and Java 17 for the `mobile` group. A `pgvector/pgvector:0.8.7-pg18-bookworm` service container sets
  `TEST_DATABASE_URL`, so the Postgres integration tests run. That tag is the one the Postgres image
  pins.
- `compose` validates `docker-compose.yml`, `docker-compose.yml` with `docker-compose.dev.yml`,
  `docker-compose.yml` with `docker-compose.prod.yml`, and `docker-compose.coolify.yml`, with placeholder
  values. It builds the `gateway`, `agent-server`, `web`, and `voice-agent` images, builds the Coolify
  `web` image and runs `nginx -t` in it, and builds the Postgres image `artemis-postgres`.

CI runs Java 17 for the `mobile` group, so `pnpm check` builds the debug APK in CI. CI does not deploy
or publish anything.

## Where tests live

- `apps/gateway/src/**/*.test.ts`, `apps/agent-server/src/**/*.test.ts`, and `apps/web/src/**/*.test.ts`,
  run by their app's check group.
- `packages/*/src/**/*.test.ts`, run by the `packages` group. Helper code under a package's `test/`
  folder is imported by those tests. The Postgres tests are in `packages/storage/src/vendor/postgres/`.
- `apps/voice-agent/tests/`, run with pytest through `uv`.
- `apps/device-client/tests/test_device.py`, run by the `device-client` group.
- `deploy/coolify/test_*.py`, run by the `deploy` group with mocked API responses. They do not contact
  Coolify.
- `scripts/check-boundaries.mjs --self-test`, run by the `boundaries` group.

Test code is exempt from the boundary rules that cover vendor imports (see
[Architecture](architecture.md#dependency-rules)).

## Android build

Build the debug APK from the repository root. Every build needs an HTTPS origin:

```powershell
.\apps\mobile\gradlew.bat -p apps\mobile -PartemisMobileUrl=https://your-host assembleDebug
```

Set `ARTEMIS_MOBILE_URL` in the environment instead of the `-P` property if you prefer. The output is
`apps/mobile/app/build/outputs/apk/debug/app-debug.apk`. `scripts/install-android.ps1` installs the
release APK when one exists and the debug APK otherwise; pass `-ApkPath` to install another file. The app's microphone permission,
authenticated downloads, and same-site previews all depend on this origin. Navigations off that origin
open in the browser. See [its README](../apps/mobile/README.md).

Debug signing values are explicit. Set `ARTEMIS_DEBUG_STORE_PASSWORD`, `ARTEMIS_DEBUG_KEY_ALIAS`, and
`ARTEMIS_DEBUG_KEY_PASSWORD` in the environment, or the matching `artemis.debug*` properties in
`local.properties`. Without them, the standard Android debug values apply. The app has no release build
type and no release signing.

Signing keys under `apps/mobile/.signing/` and build outputs are gitignored. Keep your debug keystore
between builds if you want to install updates without uninstalling.

## Known issues

- **Peer dependency warning.** `pnpm install` reports that `@assistant-ui/react-streamdown` wants
  `@streamdown/code@^1.0.0`, while `apps/web` uses `@streamdown/code` 2.0.0. This is a known issue, not
  a fixed one.
