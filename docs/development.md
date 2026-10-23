# Development

## Requirements

- Node.js 24.19.0 and pnpm 10.18.0 for the JavaScript projects.
- Python 3.13 and `uv` for the pinned checks; the voice agent supports Python 3.11–3.14.
- Docker Compose for Postgres, Hindsight, and LiveKit.
- Java 17 and Android SDK 35 for Android builds.

Copy `.env.example` to `.env`. For host-based development, use loopback URLs and
local credentials. Start the supporting services from the repository root:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres hindsight livekit
```

Install the workspace dependencies once from the repository root, then run each
application in a separate terminal:

```sh
pnpm install
pnpm --filter ./services/agent-server start
cd backend && pnpm install && pnpm dev
cd frontend && pnpm install && pnpm dev
cd voice-agent && uv sync && uv run agent dev
```

The agent server applies its database migrations at startup. For host-based runs,
set these values in `.env`: `DATABASE_URL` (the loopback Postgres port, database
`artemis`), `HINDSIGHT_URL=http://127.0.0.1:8888`, and `AGENT_SERVER_TOKEN`. Also set
`AGENT_SERVER_URL=http://127.0.0.1:4000` for the backend and
`MCP_DEVICE_BASE_URL=http://127.0.0.1:3000`.

The frontend is available at `http://127.0.0.1:5173`. Vite proxies API traffic
to the backend. When testing from another device, set `IP_ADDRESS` and
`LIVEKIT_SIGNAL_BIND` in `.env` to the host's LAN address and bind address.

## Checks

Run the project checks from the repository root:

```sh
pnpm check
```

Useful focused commands include `pnpm check:backend`, `pnpm check:frontend`,
`pnpm check:voice`, `pnpm check:devices`, `pnpm check:packages` (typecheck and tests
for `shared/`, `packages/`, and `services/`), and `pnpm check:operations` (mocked
deployment and token-rotation tests). `pnpm smoke:agent-server` runs a live smoke turn against an already-running agent server.

## Android build

Build the current debug APK with:

```powershell
.\mobile\gradlew.bat -p mobile -PartemisUrl=https://your-host assembleDebug
```

The output is `mobile/app/build/outputs/apk/debug/app-debug.apk`. The installer,
`scripts/install-android.ps1`, defaults to that current build. Pass `-ApkPath` to install a different artifact.
Every build requires an HTTPS origin through `-PartemisUrl` or the
`ARTEMIS_URL` environment variable. The matching origin is
used for microphone permissions, authenticated downloads, and same-site previews.

Keep a personal debug signing key under `mobile/.signing/` between builds if
you need to install updates without uninstalling the app. Build outputs, APKs,
local Gradle state, signing files, and local SDK paths are ignored by Git and
excluded from Docker build contexts.
