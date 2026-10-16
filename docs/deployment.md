# Deployment and operations

## Compose configuration

`docker-compose.yml` is the single application definition. Production adds the
small `docker-compose.prod.yml` validation and storage override; local host
development adds `docker-compose.dev.yml`. Copy
`.env.example` and set the production values before starting the base Compose
stack using both Compose files. The backend runs with production validation enabled. It requires unique
non-development credentials, plus absolute, separate workspace and backend-data
roots outside the checkout.

Start the production stack with:

```sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Example host roots are:

```dotenv
WORKSPACE_PATH=/data/artemis/workspace
ASSISTANT_DATA_ROOT=/data/artemis/backend-data
LETTA_DATA_VOLUME=your-existing-letta-volume
LETTA_DATA_EXTERNAL=true
LIVEKIT_SIGNAL_BIND=127.0.0.1
FRONTEND_BIND=127.0.0.1
FRONTEND_PORT=5180
```

The containers receive `WORKSPACE_PATH=/workspace` and
`ASSISTANT_DATA_ROOT=/data/backend`; Compose mounts each host root separately.
The public reverse proxy routes the site to frontend port 80. Only LiveKit media
TCP 7881 and UDP 7882 need public firewall access. Host nginx can use the
loopback frontend port for a standalone HTTPS deployment.

Compose health checks cover Letta readiness, backend process liveness (`/health`),
the frontend's proxied `/health` endpoint, and the OpenAI-compatible proxy. The
backend's `/ready` endpoint also reports Letta/MCP dependency readiness, but it
is not used to gate deployment while that asynchronous setup runs.

## Model and speech credentials

Configure ANTHROPIC_API_KEY for Claude, OPENAI_COMPATIBLE_API_KEY for Telnyx, GROQ_API_KEY for transcription, and DEEPGRAM_API_KEY for speech output in the deployment environment. The worker endpoint defaults to https://api.telnyx.com/v2/ai/openai. Local .env changes are not pushed to Git or copied into Coolify settings. Rebuild the Letta image when changing its model compatibility patches.

## Existing data migration

The old layout stored backend files under `workspace/data`. The new layout keeps
the workspace and backend data roots separate. Changing the `.env` paths does
not move existing files. Before an existing installation changes roots:

1. Stop the app's writers and make verified backups of the workspace and the existing Letta volume.
2. Create the new backend-data directory with the same owner and access needed by the container.
3. Copy the contents of the old `workspace/data` directory into the new backend-data root, preserving files and ownership.
4. Set `WORKSPACE_PATH`, `ASSISTANT_DATA_ROOT`, and the existing `LETTA_DATA_VOLUME` and `LETTA_DATA_EXTERNAL` values in `.env`.
5. Review the Compose-resolved mounts and health status before allowing the app to accept writes.

Do not remove the previous data directories or run `docker compose down -v` as
part of this migration. Retain them until the new app has been checked and a
fresh backup has been verified. Keep the existing external Letta volume name;
it contains the agent, conversations, and memory.

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
workspace, `/data/artemis/workspace/data` for backend data, and the existing
external Docker volume `livekit-letta_letta-data`; create the host directories
and retain that volume. The container paths are set inside the Compose file, so
`WORKSPACE_PATH`, `ASSISTANT_DATA_ROOT`, `LETTA_DATA_VOLUME`, and
`LETTA_DATA_EXTERNAL` do not need to be set in Coolify for this configuration.
Keep Traefik on ports 80/443 and route the app domain to the frontend container
on port 80.

`docker-compose.prod.yml` remains the production override for standalone Compose
deployments. Use it together with `docker-compose.yml` for those deployments; it
is not a standalone Compose file and should not be selected by itself in Coolify.

Do not run the old checkout and Coolify app against the same workspace or Letta
volume at once. Back up both before a migration or restore. Verify a restored
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
