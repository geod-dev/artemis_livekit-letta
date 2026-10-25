# Coolify operations

Use `docker-compose.coolify.yml` as the application's Compose file and set the
production environment values in Coolify. The application needs unique secrets and
these persistent host folders (ownership is in the host setup below):

- `/data/artemis/workspace`: the agent workspace. Its `data/` folder holds the uploads and device files.
- `/data/artemis/data/gateway`: gateway state only (attachment and retention records).

It also uses the Compose-managed `postgres-pg18` volume. Set the Coolify domain to the
`web` service on port 8080. See [deployment](../../docs/deployment.md) for storage and
recovery instructions.

## Workspace ownership

Two uids share the workspace on purpose:

- uid 1001 is the server (agent-server and gateway). It owns `data/`, so agent commands
  cannot write uploads, attachment records or device files.
- uid 1002 runs agent shell commands (`WORKSPACE_RUN_AS=1002:1001`). It is in group 1001,
  which can write the workspace root, so agents can create and edit workspace files.

The server's umask is 0002, so files it creates are group-writable and the agent can edit them.
Changing these owners breaks either the agent's writes or the read-only `data/` guarantee.

## Secrets and databases

- Database passwords (`POSTGRES_PASSWORD`, `ARTEMIS_DB_PASSWORD`, `HINDSIGHT_DB_PASSWORD`) are
  spliced into connection URLs without encoding. Use only letters and digits (hex is recommended):
  `@ : / ? #` and other URL-reserved characters break the URL. The agent server rejects a
  non-alphanumeric `ARTEMIS_DB_PASSWORD` or `HINDSIGHT_DB_PASSWORD` in production; `POSTGRES_PASSWORD`
  is not checked.
- Role passwords for `artemis` and `hindsight` are re-applied on every Postgres start, so a
  changed value takes effect after a restart. The database volume is not reset.
- `POSTGRES_PASSWORD` (the superuser) is set only when the database volume is first initialized.
  Changing it in Coolify does not change the database. To rotate it, run `ALTER USER postgres
  PASSWORD` inside the database and then update the stored value. See `deploy/postgres/README.md`.

## Network

The Compose network is pinned to `172.29.250.0/24`. The Coolify proxy must be on this subnet. The web
nginx trusts only loopback and this subnet for `X-Forwarded-For`. If the proxy reaches `web` from
another network, the login limiter sees the proxy address for every client. Change the subnet in both
`docker-compose*.yml` files and in `apps/web/nginx.conf` together if the network must move.

## Differences from docker-compose.yml

The Coolify file is kept separate because Coolify resolves host paths and routing itself.
Everything else matches the base file. The intentional differences are:

- Host folders are fixed (`/data/artemis/workspace`, `/data/artemis/data/gateway`) instead of
  `WORKSPACE_PATH` and `ARTEMIS_DATA_DIR`.
- LiveKit publishes only the media ports (7881/tcp, 7882/udp). Signaling on 7880 is reached
  through the web service's `/livekit/` proxy, not published.
- The web service has no published port; Coolify routes the domain to its port 8080.
- `LIVEKIT_PUBLIC_URL` must be set in Coolify to `wss://<domain>/livekit`. Its default points at
  the web port (5180), which Coolify does not publish, so the default does not work here.

## Host setup

Create the service account and folders before the first deployment:

```sh
sudo useradd --system --home-dir /var/lib/artemis-deploy --shell /usr/sbin/nologin artemis-deploy
sudo install -d -o artemis-deploy -g artemis-deploy -m 0700 /var/lib/artemis-deploy
sudo install -d -o artemis-deploy -g artemis-deploy -m 0750 /etc/artemis
sudo install -d -m 0755 /usr/local/lib/artemis
sudo install -d -o 1001 -g 1001 -m 0775 /data/artemis/workspace
sudo install -d -o 1001 -g 1001 -m 0755 /data/artemis/workspace/data
sudo install -d -o 1001 -g 1001 -m 0755 /data/artemis/data/gateway
```

The workspace root is 1001:1001 with mode 0775 (group 1001 is the agent's group). `data/` is
1001:1001 with mode 0755, so the agent cannot write it. Do not `chown -R` the workspace: that would
give the agent ownership of `data/`.

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

If the new token is installed but revoking the previous tokens cannot be confirmed, the script
prints the previous token ids to stderr and exits non-zero. Those tokens stay valid until they are
revoked in Coolify or the next monthly run revokes them. The unit then shows as failed, which is the alert.

These local tests use fake API responses and do not need Coolify credentials. They run
as part of `pnpm check:deploy`, or on their own from the repository root:

```sh
uv run --python 3.13 --no-project --no-sync python -m unittest discover -s deploy/coolify -p "test_*.py"
```

No deployment or token rotation is run by these tests.
