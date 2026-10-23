# Coolify operations

Use `docker-compose.coolify.yml` as the application's Compose file and set the
production environment values in Coolify. The application requires unique
secrets, persistent workspace and data host roots (`/data/artemis/workspace` and
`/data/artemis/workspace/data`), and the Compose-managed `postgres-data` volume.
See [deployment](../../docs/deployment.md) for storage and recovery instructions.

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

These local tests use fake API responses and do not need Coolify credentials:

```sh
python -m unittest infrastructure/coolify/test_poll_deploy.py infrastructure/coolify/test_rotate_token.py
```

Install the scripts and systemd units using the deployment instructions for the
host. Keep token files readable only by the deployment service account. No
deployment or token rotation is run by these tests.
