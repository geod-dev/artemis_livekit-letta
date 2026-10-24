# Deployment

Nothing in this guide has been run against a live host from this repository's current
layout. Each step taken from a script or Compose file is marked as such where it matters, and
the list at the end names what is still unverified.

## Compose files

| File | Use it for | Notes |
|---|---|---|
| `docker-compose.yml` | The base stack: `postgres`, `hindsight`, `livekit`, `agent-server`, `gateway`, `web` (the web app behind nginx), and `voice-agent`. | The services build from the repository root, except `postgres`, which builds from `deploy/postgres`. Host roots default to `./data/workspace` and `./data/gateway`. The web app is published on `WEB_BIND:WEB_PORT` (default `127.0.0.1:5180`). |
| `docker-compose.dev.yml` | Host development. | Publishes Postgres (5432) and Hindsight (8888) on loopback. Use it with the base file and start only `postgres hindsight livekit`. |
| `docker-compose.prod.yml` | Production override for a standalone Compose host. | Layered over the base file. Requires `WORKSPACE_PATH` and `ARTEMIS_DATA_DIR` and mounts them into `agent-server` and `gateway`. It sets no other values; `NODE_ENV=production` already comes from the base file. Not a standalone file. |
| `docker-compose.coolify.yml` | Coolify. Select this one file as the application's Compose file. | A complete stack with fixed host paths (`/data/artemis/workspace`, `/data/artemis/data/gateway`). Builds Postgres from `deploy/postgres`. Uses the volume `postgres-pg18`. Publishes only the LiveKit media ports. |

Standalone production start, as the full stack:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

`deploy/https/setup.sh` runs the same two files, but rebuilds and restarts only `gateway`,
`web`, and `voice-agent` (see [HTTPS on a public IP](#https-on-a-public-ip)).

## Required settings

Compose refuses to start without these (they use the `${VAR:?...}` form). The base file
requires them, and so does the Coolify file, which takes the same names:

- `POSTGRES_PASSWORD`, `ARTEMIS_DB_PASSWORD`, `HINDSIGHT_DB_PASSWORD`
- `ANTHROPIC_API_KEY` (Hindsight's model and the assistant)
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `IP_ADDRESS`
- `AGENT_SERVER_TOKEN`, `ARTEMIS_PASSWORD`, `ARTEMIS_DEVICE_TOKEN`, `VOICE_GATEWAY_TOKEN`

The production override also requires `WORKSPACE_PATH` and `ARTEMIS_DATA_DIR`.

With `NODE_ENV=production`, the gateway refuses to start unless `ARTEMIS_PASSWORD` and
`ARTEMIS_DEVICE_TOKEN` are set, and `AGENT_SERVER_TOKEN`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, and `VOICE_GATEWAY_TOKEN` are not placeholders. A placeholder is empty, the
development fallback, or a value that starts with `change-me` or `dev-`. The agent server refuses
the development token and the placeholder database passwords in production.

Other values, with their defaults and meaning, are documented in `.env.example`. The main ones
for a deployment are:

- `IP_ADDRESS`: the address clients use to reach the host.
- `LIVEKIT_PUBLIC_URL`: the browser-facing LiveKit URL. Set it to the public `wss://` URL when
  HTTPS is in front of the host.
- `WEB_BIND`, `WEB_PORT`, `LIVEKIT_SIGNAL_BIND`: host bind addresses.
- Model and speech keys: `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY` for
  workers, `GROQ_API_KEY` for transcription, `DEEPGRAM_API_KEY` for speech output, and
  `HINDSIGHT_API_KEY` only if the Hindsight deployment requires one. See [Providers](providers.md).

Local `.env` changes are not copied to Git or to Coolify. Set the values in the target
environment.

## Login and device limits

These behaviours changed with the fix round and are intended:

- **Login backoff.** The gateway counts failed logins per client address (10 per minute) and
  across all clients (50 per minute). A lockout doubles on each repeat, up to 15 minutes. A
  successful login clears the repeats. The client address comes from the socket, or from
  `X-Real-IP` when the peer is loopback or a private address (behind nginx).
- **Device names.** A device name that a connected device holds is refused with HTTP 409, and the
  existing session is kept. A lapsed device, one without a heartbeat for its lease, frees its name.
- **Voice gateway URL.** The voice agent refuses a plain-HTTP `GATEWAY_URL` unless the host is
  loopback (`localhost`, `127.0.0.1`, `::1`) or a single-label Compose service name such as
  `http://gateway:3000`. Put a remote gateway behind HTTPS.
- **Device client.** It connects to a non-loopback server only with `--server https://...`.

## Runtime data

The host roots must be absolute paths. The gateway rejects production paths inside `apps/`, and
it rejects overlapping roots.

Standalone production (`docker-compose.prod.yml`):

| Host path | Container path |
|---|---|
| `WORKSPACE_PATH` | `/workspace` in `agent-server` and `gateway` |
| `ARTEMIS_DATA_DIR` | `/data/gateway` in `gateway` only. The agent server does not mount it. |

Coolify (`docker-compose.coolify.yml`):

| Host path | Container path |
|---|---|
| `/data/artemis/workspace` | `/workspace` in `agent-server` and `gateway` |
| `/data/artemis/data/gateway` | `/data/gateway` in `gateway` only |

Ownership. Two uids share the workspace on purpose, and the server keeps `data/` read-only to the
agent:

| Host path | Owner and mode | Who writes |
|---|---|---|
| Workspace root (`WORKSPACE_PATH` or `/data/artemis/workspace`) | `1001:1001`, `0775` | Agent shell (uid 1002, group 1001) and the servers |
| `<workspace>/data/` | `1001:1001`, `0755` | The servers only. Uploads (`data/attachments/`) and device exports (`data/device-files/`) |
| `ARTEMIS_DATA_DIR` (`/data/artemis/data/gateway`) | `1001:1001`, `0750` | The gateway only |

Agent commands run as uid 1002 in group 1001 (`WORKSPACE_RUN_AS=1002:1001`). Create `<workspace>/data/`
before the first start, owned by 1001 with mode 0755, so the agent cannot create it first. Do not
run `chown -R` on the workspace. The Coolify host setup in `deploy/coolify/README.md` has the full
commands. The ownership was not checked on a server.

Postgres keeps its data in the named volume `postgres-pg18` in both the base file and the Coolify
file. Do not run `docker compose down -v` unless you intend to delete the Postgres volume.

## Postgres

### Initialisation

`deploy/postgres/init-databases.sh` runs once, only when the data volume is empty, through the
image's `/docker-entrypoint-initdb.d` hook. It creates the roles `artemis` and `hindsight` and the
databases `artemis` and `hindsight`, each owned by its role. It also enables the `vector` extension
in the `hindsight` database.

Both the base file and the Coolify file build `deploy/postgres/Dockerfile`, which pins the
`pgvector/pgvector:0.8.7-pg18-bookworm` image. The script is baked into the image, because Coolify
resolves bind mounts on the host, where the checkout does not exist.

### Role passwords

`deploy/postgres/entrypoint.sh` wraps the stock entrypoint and runs `ALTER ROLE` for `artemis` and
`hindsight` on every start. A changed `ARTEMIS_DB_PASSWORD` or `HINDSIGHT_DB_PASSWORD` therefore
takes effect after a restart, and the database volume is not reset. `POSTGRES_PASSWORD` (the
superuser) is set only when the volume is first created.

### Password characters

The three database passwords are spliced into connection URLs without encoding. Use only letters
and digits; hex is recommended. The characters `@ : / ? #` and other URL-reserved characters break
the URL. Nothing checks this, so check the values before the first start.

## Network

The Compose network is pinned to `172.29.250.0/24`. The web nginx sets the client address from
`X-Forwarded-For` only for loopback and this subnet. If Coolify's proxy reaches `web` from another
network, the login limiter sees the proxy address for every client. Put the proxy on the
application's network, or change the subnet in both `docker-compose*.yml` files and in
`apps/web/nginx.conf` together.

## Coolify

Prerequisites on the Coolify host, before the first deploy of this layout:

1. Create `/data/artemis/workspace` and `/data/artemis/workspace/data`, and create
   `/data/artemis/data/gateway`. Owners and modes are in the [Runtime data](#runtime-data) table
   and in `deploy/coolify/README.md`.
2. The gateway's state folder is `/data/artemis/data/gateway`. It starts empty, because there is
   no user data to copy. The workspace itself stays at `/data/artemis/workspace`.
3. Leave `WORKSPACE_PATH` and `ARTEMIS_DATA_DIR` unset in Coolify. The Coolify Compose file fixes
   the host mounts, and the gateway's container environment sets `ARTEMIS_DATA_DIR=/data/gateway`
   and `WORKSPACE_PATH=/workspace`.
4. Set the required settings above and the other values you need in Coolify. Set
   `LIVEKIT_PUBLIC_URL` to the public `wss://` URL that ends in `/livekit`, as the comment in
   `docker-compose.coolify.yml` says.
5. Set the Coolify domain to the `web` service on port 8080. Its nginx serves the app and proxies
   `/api` and `/livekit/` to the internal services. LiveKit's signal port (7880) is not published
   and needs no domain of its own.
6. Open TCP 7881 and UDP 7882 on the host firewall for LiveKit media.
7. Do not run two deployments against the same workspace at once.

Automation under `deploy/coolify/`:

- `poll_deploy.py` (run by `artemis-deploy.timer`, 60 seconds after each run ends) requests a
  deploy through Coolify's loopback API for the configured branch. It records a commit as deployed
  only when the deployment reports the same full 40-character hash. A missing or different hash is
  recorded as failed, and the same hash is not retried automatically.
- `rotate_token.py` (run by `artemis-token-rotation.timer`, monthly) issues a token with a 90-day
  expiry, validates it against the application, then replaces the local token file atomically with
  mode 0600 and revokes the previous tokens. If validation fails, it revokes only the new token.

The `deploy/coolify/README.md` file names the owners, modes, and systemd units. Those host
instructions are not in the repository as a runbook, and the installation was not checked here.

## HTTPS on a public IP

`deploy/https/setup.sh` sets up HTTPS for a standalone host running Compose. It is for Debian or
Ubuntu, and it needs nginx, Docker, Python 3, and Certbot 5.4 or newer (IP certificates need that
version). Allow inbound TCP 80 and 443, and TCP 7881 and UDP 7882 for LiveKit. Run it as root from
the checkout, with `.env` present:

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
- Rewrites `WEB_BIND=127.0.0.1`, `WEB_PORT=5180`, and `LIVEKIT_PUBLIC_URL=wss://<ip>/livekit` in
  `.env`.
- Rebuilds and restarts `gateway`, `web`, and `voice-agent` with the base and production files
  (`up -d --build gateway web voice-agent`), then checks the public health endpoint.
- Restores the previous `.env` and nginx site if any step fails.
- Installs `assistant-certbot.timer`, which runs `certbot renew` every six hours. A renewal hook
  reloads nginx.

Keep TCP 80 open. Certificate renewal uses it.

## Voice agent settings

The voice agent container gets its settings from the environment that Compose passes in. Outside
Compose, it reads the env file named by `VOICE_ENV_FILE`, or the repository-root `.env` when that
variable is unset and the file exists. See its [README](../apps/voice-agent/README.md).

## Fresh start

A new stack starts with an empty database and empty host roots. No earlier data is imported. Keep
any volume from a previous stack until you no longer need it.

## Not verified in this environment

- The Compose startup of the base and production stacks, including the image builds.
- The Coolify deployment, the systemd units, and the poller and rotation running on a host.
- `deploy/https/setup.sh` on a real public IP.
- The workspace and data-directory permissions for uid 1001 and 1002.
- The Postgres init script and the role-password step on a fresh volume.

The repository's checks cover the mocked deployment scripts (`pnpm check:deploy`) and the apps'
own tests. None of them start the Compose stack.
