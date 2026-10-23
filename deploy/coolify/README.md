# Coolify operations

Use `docker-compose.coolify.yml` as the application's Compose file and set the
production environment values in Coolify. The application needs unique secrets and
these persistent host folders, all owned by uid 1001 (`chown -R 1001:1001`):

- `/data/artemis/workspace`: the agent workspace. Uploads and device files live in its `data/` folder.
- `/data/artemis/data/gateway`: gateway state only (attachment and retention records).

It also uses the Compose-managed `postgres-pg18` volume. Set the Coolify domain to the
`web` service on port 8080. See [deployment](../../docs/deployment.md) for storage and
recovery instructions.

## Differences from docker-compose.yml

The Coolify file is kept separate because Coolify resolves host paths and routing itself.
Everything else matches the base file. The intentional differences are:

- Host folders are fixed (`/data/artemis/workspace`, `/data/artemis/data/gateway`) instead of
  `WORKSPACE_PATH` and `ARTEMIS_DATA_DIR`.
- LiveKit publishes only the media ports (7881/tcp, 7882/udp). Signaling on 7880 is reached
  through the web service's `/livekit/` proxy, not published.
- The web service has no published port; Coolify routes the domain to its port 8080.

## Host setup

Create the service account and folders before the first deployment:

```sh
sudo useradd --system --home-dir /var/lib/artemis-deploy --shell /usr/sbin/nologin artemis-deploy
sudo install -d -o artemis-deploy -g artemis-deploy -m 0700 /var/lib/artemis-deploy
sudo install -d -o artemis-deploy -g artemis-deploy -m 0750 /etc/artemis
sudo install -d -m 0755 /usr/local/lib/artemis
sudo install -d -m 0750 /data/artemis/workspace /data/artemis/data/gateway
sudo chown -R 1001:1001 /data/artemis/workspace /data/artemis/data/gateway
```

Install the scripts and units. The units expect these paths:

- Scripts: `/usr/local/lib/artemis/poll_deploy.py` and `rotate_token.py`, owned by root, mode `0644`.
- Units: `deploy/coolify/artemis-deploy.{service,timer}` and `artemis-token-rotation.{service,timer}`, copied to `/etc/systemd/system/`.
- Config: `/etc/artemis/coolify-deploy.json`, owned by `root:artemis-deploy`, mode `0640`. It names `token_file`, `application_uuid`, `repository` and `branch`.
- Token file: named by `token_file`, owned by `artemis-deploy`, mode `0600`. Rotation writes it in `/etc/artemis`, so that directory must stay writable by `artemis-deploy`.
- State: `/var/lib/artemis-deploy`, owned by `artemis-deploy`, mode `0700`.

Then run `sudo systemctl daemon-reload` and enable the two timers.

The units run as `artemis-deploy`. The token rotation unit also gets the `docker` group
(`SupplementaryGroups=docker`) because `rotate_token.py` reaches Coolify's console through
`docker exec`. Docker group membership is root-equivalent, so only that unit has it. The
deployment poller does not run Docker and does not have it. Token rotation is not retried
automatically; the monthly timer runs it again.

## Deployment poller

`poll_deploy.py` checks the configured public Git branch and requests a deploy
through Coolify's loopback API. It waits while any deployment is active. It
records success only when the deployment reports the same full commit hash that
was requested. A missing or different revision is recorded as failed; the same
failed hash is held to prevent a retry loop. Advance the branch or retry that
revision manually in Coolify.

## Token rotation

`rotate_token.py` issues a read/deploy token with a 90-day expiry, validates it
against the configured application, then atomically replaces the local token
file and revokes previous tokens. Validation failure revokes only the newly
issued token and leaves the prior token file unchanged.

These local tests use fake API responses and do not need Coolify credentials. They run
as part of `pnpm check:deploy`, or on their own from the repository root:

```sh
uv run --python 3.13 --no-project --no-sync python -m unittest discover -s deploy/coolify -p "test_*.py"
```

No deployment or token rotation is run by these tests.
