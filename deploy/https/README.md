# HTTPS setup for a standalone host

`setup.sh` puts the Compose stack behind an HTTPS edge on a public IPv4 address, using a
Let's Encrypt IP certificate. It is for a Debian or Ubuntu host that runs the stack directly, not
for the Coolify deployment (see `deploy/coolify/README.md`).

## Running it

Run it as root from a checkout that has a configured `.env`. The address is the only argument:

```sh
sudo env CERTBOT_EMAIL=ops@example.com sh deploy/https/setup.sh 203.0.113.10
```

## Requirements

- `.env` in the repository root, with `WORKSPACE_PATH` and `ARTEMIS_DATA_DIR` set to separate
  absolute host folders outside `apps/`.
- `CERTBOT_EMAIL` (required): the ACME account contact for expiry and revocation notices.
- Certbot 5.4 or newer (IP certificates). Set `CERTBOT` to a specific binary if it is not on `PATH`.
- `nginx`, `docker` with the Compose plugin, and `python3` on the host.

## What it changes

- `.env`: it removes the `WEB_BIND`, `WEB_PORT` and `LIVEKIT_PUBLIC_URL` lines and appends
  `WEB_BIND=127.0.0.1`, `WEB_PORT=5180` and the public `LIVEKIT_PUBLIC_URL=wss://<ip>/livekit`.
  The file's mode is kept.
- `/etc/nginx/sites-available/assistant`, enabled through `sites-enabled`. It first installs a
  port-80 bootstrap for the ACME challenge, then the HTTPS template in `nginx.conf.template`.
- `/var/www/assistant-acme`: the webroot for the challenge.
- `/etc/letsencrypt`: the certificate for the IP, a renewal deploy hook that reloads nginx, and
  `assistant-certbot.service` and `.timer` under `/etc/systemd/system`, which renew every six hours.
- It runs `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build gateway web voice-agent`.

If any step fails before the final health checks pass, an exit trap restores `.env` and the nginx
site from backups and reloads nginx. Containers that Compose has already recreated keep the new
configuration until the next successful deploy.

## Checks

The script checks the gateway's `/health` inside its container, then the public
`https://<ip>/health` response, which must report `status` `ok`.
