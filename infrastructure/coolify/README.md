# Artemis on Coolify

Production runs as the **Artemis** Docker Compose application in the **Artemis / production** project on the local Coolify server. Coolify clones `main`, builds the images, starts the containers and retains deployment logs.

## Persistent data

The application environment contains:

```dotenv
WORKSPACE_PATH=/data/artemis/workspace
LETTA_DATA_VOLUME=livekit-letta_letta-data
LETTA_DATA_EXTERNAL=true
COMPOSE_PROJECT_NAME=iakgsm1age87oct55wknozc6
FRONTEND_BIND=127.0.0.1
FRONTEND_PORT=5180
LIVEKIT_PUBLIC_URL=wss://185.252.233.123/livekit
```

The workspace is independent of Git clones. The external Letta volume holds the existing agents, conversations and memory. Do not delete these paths or run `docker compose down -v`. Production previews are disabled because this installation shares persistent data and fixed ports.

Letta updates are applied through its Docker image. Its internal updater is disabled because the image and compatibility patch require version 0.34.4.

## Automatic deployments

`artemis-deploy.timer` checks the public repository's `main` branch every minute. A new commit is deployed through the local Coolify API. Deployments appear in the same Coolify interface as manual deployments. No GitHub account credential is stored on the VPS, and no GitHub App installation is required.

The checker serializes its operations, waits for an active deployment and records successful commits. A failed commit is recorded rather than repeatedly rebuilt. Push a correction or use Coolify's Deploy button to retry manually. A rollback made manually in Coolify is retained until a new commit arrives on `main`.

Installed files:

- `/usr/local/lib/artemis/poll-deploy.py`
- `/usr/local/lib/artemis/rotate-token.py`
- `/etc/artemis/coolify-deploy.json` and `/etc/artemis/coolify-token`, readable only by root
- `/var/lib/artemis-deploy/state.json`
- Systemd units matching the files in this directory

The API token has only `read` and `deploy` permissions and expires after 90 days. `artemis-token-rotation.timer` renews it monthly, validates the replacement, installs it atomically and revokes the previous token. Configuration tokens used during migration are revoked after setup.

```sh
systemctl status artemis-deploy.timer artemis-token-rotation.timer
journalctl -u artemis-deploy.service -u artemis-token-rotation.service
```

## HTTPS and ports

- Artemis: `https://185.252.233.123`
- Coolify: `https://185.252.233.123:8443`
- Both are served by host nginx using the existing trusted IP certificate and renewal timer.
- Coolify's 8000, 6001 and 6002 ports are bound to loopback. Nginx forwards dashboard requests, `/app/` realtime WebSockets and `/terminal/ws` terminal WebSockets over HTTPS on 8443.
- Public ports in use: TCP 22 (SSH), 80/443 (Artemis and certificate renewal), 8443 (Coolify), 7881 and UDP 7882 (LiveKit media). The current Compose also publishes LiveKit signaling on TCP 7880; browser signaling uses `/livekit` over HTTPS.

Coolify's built-in proxy is set to `NONE` because host nginx handles these endpoints. Coolify remains responsible for application builds and container lifecycle.

## Backups and recovery

Migration backups and the original checkout are retained under `/root/coolify-migration` and `/root/artemis_livekit-letta`. The cutover backup includes verified workspace and Letta archives plus `SHA256SUMS`. The original checkout's containers must remain stopped while Coolify is running.

For recovery, stop writers before restoring data. Restore the workspace to `/data/artemis/workspace` and Letta files into the existing external volume, preserving ownership. Restore a matching Coolify database backup together with `/data/coolify/source/.env`; its `APP_KEY` is required to decrypt the saved application secrets. Never run both the legacy and Coolify applications against the same data simultaneously.

The nginx configurations are `/etc/nginx/sites-available/assistant` and `/etc/nginx/sites-available/coolify`. The loopback port override is `/data/coolify/source/docker-compose.custom.yml`. Keep that override when upgrading Coolify.
