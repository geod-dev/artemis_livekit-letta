# Deployment and operations

## Compose configuration

`docker-compose.yml` is the single application definition. It runs `postgres`
(pgvector, databases `artemis` and `hindsight` on the `postgres-data` volume),
`hindsight` (memory), `agent-server`, `backend` (gateway), `frontend`, `livekit`,
and `voice-agent`. Production adds the small `docker-compose.prod.yml` validation
and storage override; local host development adds `docker-compose.dev.yml`. Copy
`.env.example` and set the production values before starting the base Compose
stack using both Compose files. The backend runs with production validation enabled. It requires unique
non-development credentials, plus absolute, separate workspace and backend-data
roots outside the checkout. Compose also requires `POSTGRES_PASSWORD`,
`ARTEMIS_DB_PASSWORD`, `HINDSIGHT_DB_PASSWORD`, and `ANTHROPIC_API_KEY`.
`agent-server` refuses the development `AGENT_SERVER_TOKEN` when `NODE_ENV=production`.

Start the production stack with:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Example host roots are:

```dotenv
WORKSPACE_PATH=/data/artemis/workspace
ASSISTANT_DATA_ROOT=/data/artemis/backend-data
LIVEKIT_SIGNAL_BIND=127.0.0.1
FRONTEND_BIND=127.0.0.1
FRONTEND_PORT=5180
```

Compose sets `WORKSPACE_PATH=/workspace` inside the containers and mounts each
host root separately. The workspace is mounted at `/workspace` in `agent-server`
and `backend`. The data root is mounted at `/workspace/data` in `agent-server` and
at `/data/backend` in `backend`.
The public reverse proxy routes the site to frontend port 80. Only LiveKit media
TCP 7881 and UDP 7882 need public firewall access. Host nginx can use the
loopback frontend port for a standalone HTTPS deployment.

Compose health checks cover Postgres (`pg_isready`), Hindsight (`/health/ready`),
agent-server (`/ready`), backend, and the frontend's proxied `/health` endpoint.
The backend's `/ready` endpoint also reports agent-server readiness. The Coolify
file checks the backend's `/health` instead, so asynchronous setup does not block
deployment.

## Model and speech credentials

Configure ANTHROPIC_API_KEY for Claude and memory, OPENAI_COMPATIBLE_API_KEY for Telnyx, GROQ_API_KEY for transcription, and DEEPGRAM_API_KEY for speech output in the deployment environment. Set AGENT_SERVER_TOKEN, shared by the backend and agent-server. Set HINDSIGHT_API_KEY for agent-server if the Hindsight deployment requires one. The worker endpoint defaults to https://api.telnyx.com/v2/ai/openai. Local .env changes are not pushed to Git or copied into Coolify settings.

## Fresh start and data

The Postgres database is new and starts empty; no earlier data is imported. Any
volume left from the previous stack is not used by this stack. Keep it until you
no longer need it. Do not run `docker compose down -v` unless you intend to delete `postgres-data`.

The init script `infrastructure/postgres/init-databases.sh` creates the `artemis`
and `hindsight` roles and databases only when `postgres-data` is empty.

Agent commands run as uid 1001 (`WORKSPACE_RUN_AS`). That user must be able to
write the directory at `WORKSPACE_PATH`. The data root is written by the containers
and is read-only for agent commands.

For a new installation, create the two host directories before startup. The
application starts with an empty workspace and backend data directory.

## HTTPS on a public IP

The standalone host setup expects Debian or Ubuntu, nginx, Docker Compose,
Python 3, and Certbot 5.4 or newer. Certbot 5.4 supports IP address certificates
with the webroot flow. Allow inbound TCP 80/443 and LiveKit TCP 7881/UDP 7882.
Run as root from the checkout:

```sh
CERTBOT=/path/to/certbot sh infrastructure/https/setup.sh PUBLIC_IPV4
```

The script validates the IPv4 address and Certbot version before changing host
configuration. It backs up `.env` and the existing nginx site, obtains a
certificate when needed, binds frontend and LiveKit signaling to loopback,
rebuilds the relevant services, then checks backend liveness and public HTTPS
JSON health. If deployment or health validation fails, it restores the previous
`.env` and nginx site. The renewal timer checks every six hours and reloads nginx
after a successful renewal. Keep TCP 80 open for certificate renewal.

## Coolify

Configure Coolify to use `docker-compose.coolify.yml` as its single Compose file
and set the application environment values in Coolify. This file is a complete
production stack with static volume sources because Coolify rejects environment
substitution in bind mount paths. It uses `/data/artemis/workspace` for the
workspace, `/data/artemis/workspace/data` for the data directory, and the
Compose-managed `postgres-data` volume. Create the host directories before
deploying. The container paths are set inside the Compose file, so
`WORKSPACE_PATH` and `ASSISTANT_DATA_ROOT` do not need to be set in Coolify for
this configuration. Keep Traefik on ports 80/443 and route the app domain to the
frontend container on port 80.

`docker-compose.prod.yml` remains the production override for standalone Compose
deployments. Use it together with `docker-compose.yml` for those deployments; it
is not a standalone Compose file and should not be selected by itself in Coolify.

Do not run two deployments against the same workspace at once. Verify a restored
Coolify database together with its encryption key before relying on saved
application secrets.

## Automatic deployments

The Coolify deployment poller only records a commit as deployed when the
deployment API reports that exact 40-character revision. A missing or different
revision is held as failed and is not retried automatically for the same hash;
advance the branch or retry it manually in Coolify. Active deployments are left
alone. The poller and token rotation tests use fake API responses and never call
the live server.

Token rotation validates the newly issued credential before replacing the local
token file. If validation fails, it revokes the new token and keeps the old file
and prior token intact. The replacement file is installed atomically with mode
0600, then previous tokens are revoked.
