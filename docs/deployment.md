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

Compose health checks cover Letta readiness, the backend's `/ready` dependency
state, the frontend's proxied `/health` endpoint, and the OpenAI-compatible proxy.
`/health` is unauthenticated backend liveness. It is suitable for health checks;
authenticated conversation routes are not.

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

Configure Coolify to use `docker-compose.yml` together with
`docker-compose.prod.yml`, and set environment values in its application
settings. The former duplicated Coolify Compose file has been removed so
production service definitions and health checks have one source. Before
redeploying an existing Coolify application, update its Compose file setting and
provide the persistent roots and existing external Letta volume in the
application environment. Keep Traefik on ports 80/443 and route the app domain
to the frontend container on port 80.

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
