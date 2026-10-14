#!/bin/sh
# Debian/Ubuntu host, run as root from a checkout with a configured .env.
set -eu
ip=${1:?Usage: sh infrastructure/https/setup.sh PUBLIC_IPV4}

# Validate four decimal octets without accepting signs, shorthand or overflow.
case "$ip" in *[!0-9.]*|'') echo 'Expected an IPv4 address' >&2; exit 1 ;; esac
old_ifs=$IFS
IFS=.
set -- $ip
IFS=$old_ifs
if [ "$#" -ne 4 ]; then echo 'Expected an IPv4 address' >&2; exit 1; fi
for octet do
  case "$octet" in ''|*[!0-9]*) echo 'Expected an IPv4 address' >&2; exit 1 ;; esac
  normalized=$(printf '%s' "$octet" | sed 's/^0*//')
  [ -n "$normalized" ] || normalized=0
  if [ "${#normalized}" -gt 3 ] || [ "$normalized" -gt 255 ]; then
    echo 'IPv4 octets must be between 0 and 255' >&2
    exit 1
  fi
done

repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo"
test -f .env
if [ -n "${CERTBOT:-}" ]; then
  certbot=$CERTBOT
else
  certbot=$(command -v certbot) || { echo 'Certbot is required' >&2; exit 1; }
fi
certbot_version=$("$certbot" --version 2>&1 | sed -n 's/.*certbot \([0-9][0-9.]*\).*/\1/p' | head -n 1)
if [ -z "$certbot_version" ] || ! awk -v version="$certbot_version" 'BEGIN {
  count = split(version, part, ".")
  if (count < 2 || part[1] + 0 < 5 || (part[1] + 0 == 5 && part[2] + 0 < 4)) exit 1
}'; then
  echo "Certbot 5.4 or newer is required for IP certificates (found: ${certbot_version:-unknown})" >&2
  exit 1
fi
command -v nginx >/dev/null
command -v docker >/dev/null
command -v python3 >/dev/null

site=/etc/nginx/sites-available/assistant
enabled=/etc/nginx/sites-enabled/assistant
env_backup=$(mktemp)
nginx_backup=$(mktemp)
env_new=
nginx_new=
bootstrap=
cp -p .env "$env_backup"
had_site=0
if [ -e "$site" ]; then cp -p "$site" "$nginx_backup"; had_site=1; fi
committed=0
rollback() {
  result=$?
  if [ "$committed" -ne 1 ]; then
    cp -p "$env_backup" .env
    if [ "$had_site" -eq 1 ]; then cp -p "$nginx_backup" "$site"; else rm -f "$site"; fi
    if [ -e "$enabled" ] && [ ! -e "$site" ]; then rm -f "$enabled"; fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  fi
  [ -z "$env_new" ] || rm -f "$env_new"
  [ -z "$nginx_new" ] || rm -f "$nginx_new"
  [ -z "$bootstrap" ] || rm -f "$bootstrap"
  rm -f "$env_backup" "$nginx_backup"
  exit "$result"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p /var/www/assistant-acme
# Bootstrap validation without requiring an existing certificate.
if [ ! -f "/etc/letsencrypt/live/$ip/fullchain.pem" ]; then
  bootstrap=$(mktemp "${site}.XXXXXX")
  cat > "$bootstrap" <<EOF
server {
  listen 80;
  server_name $ip;
  location /.well-known/acme-challenge/ { root /var/www/assistant-acme; }
  location / { proxy_pass http://127.0.0.1:5173; }
}
EOF
  mv "$bootstrap" "$site"
  ln -sf "$site" "$enabled"
  nginx -t
  systemctl reload nginx
  "$certbot" certonly --non-interactive --agree-tos --register-unsafely-without-email \
    --preferred-profile shortlived --webroot --webroot-path /var/www/assistant-acme \
    --cert-name "$ip" --ip-address "$ip"
fi

# Atomically update the host settings; the EXIT handler restores the prior file
# if Compose, nginx validation, or post-start health checks fail.
env_new=$(mktemp .env.https.XXXXXX)
awk '!/^FRONTEND_BIND=/ && !/^FRONTEND_PORT=/ && !/^LIVEKIT_PUBLIC_URL=/' .env > "$env_new"
printf '\nFRONTEND_BIND=127.0.0.1\nFRONTEND_PORT=5180\nLIVEKIT_PUBLIC_URL=wss://%s/livekit\n' "$ip" >> "$env_new"
chmod --reference=.env "$env_new"
mv "$env_new" .env
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build backend frontend voice-agent

nginx_new=$(mktemp "${site}.XXXXXX")
sed "s/@IP@/$ip/g" infrastructure/https/nginx.conf.template > "$nginx_new"
mv "$nginx_new" "$site"
ln -sf "$site" "$enabled"
nginx -t
systemctl reload nginx

mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nnginx -t && systemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/assistant-nginx
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/assistant-nginx
cat > /etc/systemd/system/assistant-certbot.service <<EOF
[Unit]
Description=Renew assistant HTTPS certificate
[Service]
Type=oneshot
ExecStart=$certbot renew --quiet
EOF
cat > /etc/systemd/system/assistant-certbot.timer <<EOF
[Unit]
Description=Check assistant HTTPS certificate every six hours
[Timer]
OnCalendar=*-*-* 00,06,12,18:00:00
RandomizedDelaySec=600
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now assistant-certbot.timer

# Backend liveness is unauthenticated. Check it inside the service, then verify
# that the public TLS route serves the application without an authenticated API.
attempt=0
until docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T backend node -e \
  "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 15 ]; then echo 'Backend health check failed' >&2; exit 1; fi
  sleep 2
done
curl --fail --silent --show-error --retry 15 --retry-delay 2 --retry-connrefused \
  -H 'Accept: application/json' "https://$ip/health" \
  | python3 -c 'import json,sys; body=json.load(sys.stdin); sys.exit(0 if body.get("status") == "ok" else 1)'
committed=1
printf '\nReady: https://%s\n' "$ip"
