# Deployment

Nothing in this guide has been run against a live host from this repository's current
layout. Each step taken from a script or Compose file is marked as such where it matters,
and the list at the end names what is still unverified.

## Compose files

| File | Use it for | Notes |
|---|---|---|
| `docker-compose.yml` | The base stack: `postgres`, `hindsight`, `livekit`, `agent-server`, `gateway`, `web` (the web app behind nginx), and `voice-agent`. | Builds from the repository root. Host roots default to `./data/workspace` and `./data/gateway`. The web app is published on `WEB_BIND:WEB_PORT` (default `127.0.0.1:5180`). |
| `docker-compose.dev.yml` | Host development. | Publishes Postgres (5432) and Hindsight (8888) on loopback. Use it with the base file and start only `postgres hindsight livekit`. |
| `docker-compose.prod.yml` | Production override for a standalone Compose host. | Layered over the base file. Requires `WORKSPACE_PATH` and `ARTEMIS_DATA_DIR`, mounts them, and sets `NODE_ENV=production` on the gateway. Not a standalone file. |
| `docker-compose.coolify.yml` | Coolify. Select this one file as the application's Compose file. | A complete stack with fixed host paths (`/data/artemis/workspace`, `/data/artemis/data/gateway`). Builds Postgres from `deploy/postgres`. Uses the volume `postgres-pg18`. Publishes no loopback ports. |

Standalone production start, as used by `deploy/https/setup.sh` (not run here):

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

## Required settings

Compose refuses to start without these (they use the `${VAR:?...}` form). Both the base
file and the Coolify file require them:

- `POSTGRES_PASSWORD`, `ARTEMIS_DB_PASSWORD`, `HINDSIGHT_DB_PASSWORD`
- `ANTHROPIC_API_KEY` (Hindsight's model and the assistant)
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`

The production override also requires `WORKSPACE_PATH` and `ARTEMIS_DATA_DIR`.

With `NODE_ENV=production`, the gateway refuses to start unless `ARTEMIS_PASSWORD` and
`ARTEMIS_DEVICE_TOKEN` are set, `AGENT_SERVER_TOKEN` is not the development value,
`LIVEKIT_API_KEY` is not `devkey`, `LIVEKIT_API_SECRET` is not `secret`, and
`VOICE_GATEWAY_TOKEN` is not the development default. The agent server refuses the
development token and placeholder database passwords in production.

Other values, with their defaults and meaning, are documented in `.env.example`. The main
ones for a deployment are:

- `IP_ADDRESS`: the address clients use to reach the host.
- `LIVEKIT_PUBLIC_URL`: the browser-facing LiveKit URL when HTTPS is in front of it.
- `WEB_BIND`, `WEB_PORT`, `LIVEKIT_SIGNAL_BIND`: host bind addresses.
- Model and speech keys: `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY` for
  workers, `GROQ_API_KEY` for transcription, `DEEPGRAM_API_KEY` for speech output, and
  `HINDSIGHT_API_KEY` only if the Hindsight deployment requires one. See
  [Providers](providers.md).

Local `.env` changes are not copied to Git or to Coolify. Set the values in the target
environment.

## Runtime data

The host roots must be absolute paths. The gateway rejects production paths inside
`apps/`, and it rejects overlapping roots.

Standalone production (`docker-compose.prod.yml`):

| Host path | Container path |
|---|---|
| `WORKSPACE_PATH` | `/workspace` in `agent-server` and `gateway` |
| `ARTEMIS_DATA_DIR` | `/data/gateway` in `gateway` only. The agent-server does not mount it. |

Coolify (`docker-compose.coolify.yml`):

| Host path | Container path |
|---|---|
| `/data/artemis/workspace` | `/workspace` in `agent-server` and `gateway` |
| `/data/artemis/data/gateway` | `/data/gateway` in `gateway` only |

Agent commands run as uid 1001 (`WORKSPACE_RUN_AS=1001:1001`). The host workspace
directory must be writable by that uid. This was not checked on the server.

Postgres keeps its data in the named volume `postgres-pg18` in both the base file and the
Coolify file. The name was changed from `postgres-data` on purpose, so that the init script
runs on a fresh volume.

Do not run `docker compose down -v` unless you intend to delete the Postgres volume.

## Postgres initialisation

`deploy/postgres/init-databases.sh` runs once, only when the data volume is empty, through
the image's `/docker-entrypoint-initdb.d` hook. It creates the roles `artemis` and
`hindsight` and the databases `artemis` and `hindsight`, each owned by its role. It also
enables the `vector` extension in the `hindsight` database.

- The base file mounts the script read-only into the stock `pgvector/pgvector:pg18` image.
- The Coolify file builds the image from `deploy/postgres/Dockerfile` instead. Coolify
  resolves bind mounts on the host, where the checkout does not exist, so the script is
  baked into the image.

Because the script runs only on an empty volume, changing a password in `.env` does not
reach an existing volume.

## Coolify

Prerequisites on the Coolify host, before the first deploy of this layout:

1. Create `/data/artemis/workspace` if it does not exist. It is the workspace. It must be
   writable by uid 1001.
2. Create `/data/artemis/data/gateway`. The gateway's data folder moves here from
   `/data/artemis/workspace/data`. It starts empty, because there is no user data to copy.
   The workspace itself stays at `/data/artemis/workspace`.
3. Leave `WORKSPACE_PATH` and `ARTEMIS_DATA_DIR` unset in Coolify. The Coolify Compose file
   fixes the host mounts, and the gateway's container environment sets
   `ARTEMIS_DATA_DIR=/data/gateway` and `WORKSPACE_PATH=/workspace`.
4. Set the required settings above and the other values you need in Coolify.
5. Set the Coolify domain to the `web` service on port 80, and set the LiveKit
   service on port 7880 for WebSocket signaling. The comment at the top of
   `docker-compose.coolify.yml` gives both.
6. Open TCP 7881 and UDP 7882 on the host firewall for LiveKit media.
7. Do not run two deployments against the same workspace at once.

Automation under `deploy/coolify/`:

- `poll_deploy.py` (run by `artemis-deploy.timer`, 60 seconds after each run ends)
  requests a deploy through Coolify's loopback API for the configured branch. It records a
  commit as deployed only when the deployment reports the same full 40-character hash. A
  missing or different hash is recorded as failed, and the same hash is not retried
  automatically.
- `rotate_token.py` (run by `artemis-token-rotation.timer`, monthly) issues a token with a
  90-day expiry, validates it against the application, then replaces the local token file
  atomically with mode 0600 and revokes the previous tokens. If validation fails, it
  revokes only the new token.

The README in `deploy/coolify/` says to install the scripts and systemd units by following
the host's deployment instructions. Those instructions are not in the repository, and the
installation was not checked here.

## HTTPS on a public IP

`deploy/https/setup.sh` sets up HTTPS for a standalone host running Compose. It is for
Debian or Ubuntu, and it needs nginx, Docker, Python 3, and Certbot 5.4 or newer (IP
certificates need that version). Allow inbound TCP 80 and 443, and TCP 7881 and UDP 7882
for LiveKit. Run it as root from the checkout, with `.env` present:

```sh
CERTBOT=/path/to/certbot sh deploy/https/setup.sh PUBLIC_IPV4
```

`CERTBOT` is optional. Without it, the script uses `certbot` from `PATH`.

What the script does, from its source:

- Validates the IPv4 address and the Certbot version.
- Backs up `.env` and any existing nginx site.
- Obtains a Let's Encrypt certificate for the IP address with `certbot certonly`.
- Writes the nginx site `/etc/nginx/sites-available/assistant` from
  `deploy/https/nginx.conf.template`.
- Rewrites `WEB_BIND=127.0.0.1`, `WEB_PORT=5180`, and
  `LIVEKIT_PUBLIC_URL=wss://<ip>/livekit` in `.env`.
- Rebuilds and restarts `gateway`, `web`, and `voice-agent` with the base and
  production files, then checks the public health endpoint.
- Restores the previous `.env` and nginx site if any step fails.
- Installs `assistant-certbot.timer`, which runs `certbot renew` every six hours. A renewal
  hook reloads nginx.

Keep TCP 80 open. Certificate renewal uses it.

## Fresh start

A new stack starts with an empty database and empty host roots. No earlier data is
imported. Keep any volume from a previous stack until you no longer need it.

## Not verified in this environment

- The Compose startup of the base and production stacks, including the image builds.
- The Coolify deployment, the systemd units, and the poller and rotation running on a host.
- `deploy/https/setup.sh` on a real public IP.
- The workspace and data-directory permissions for uid 1001.
- The Postgres init script on a fresh volume.

The repository's checks cover the mocked deployment scripts (`pnpm check:deploy`) and the
apps' own tests. None of them start the Compose stack.
