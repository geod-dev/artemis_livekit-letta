#!/bin/sh
# Debian/Ubuntu host, run as root from a checkout with a configured .env.
set -eu
ip=${1:?Usage: sh infrastructure/https/setup.sh PUBLIC_IPV4}
case "$ip" in *[!0-9.]*|'') echo 'Expected an IPv4 address' >&2; exit 1 ;; esac
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo"
test -f .env
certbot=${CERTBOT:-$(command -v certbot)}
# Requires Certbot >=5.4 for webroot validation of IP addresses.
"$certbot" --version
command -v nginx >/dev/null
mkdir -p /var/www/assistant-acme

# Bootstrap validation without requiring an existing certificate.
if [ ! -f "/etc/letsencrypt/live/$ip/fullchain.pem" ]; then
  cat > /etc/nginx/sites-available/assistant <<EOF
server {
  listen 80;
  server_name $ip;
  location /.well-known/acme-challenge/ { root /var/www/assistant-acme; }
  location / { proxy_pass http://127.0.0.1:5173; }
}
EOF
  ln -sf /etc/nginx/sites-available/assistant /etc/nginx/sites-enabled/assistant
  nginx -t
  systemctl reload nginx
  "$certbot" certonly --non-interactive --agree-tos --register-unsafely-without-email \
    --preferred-profile shortlived --webroot --webroot-path /var/www/assistant-acme \
    --cert-name "$ip" --ip-address "$ip"
fi

cp -p .env ".env.pre-https.$(date +%s)"
sed -i '/^FRONTEND_BIND=/d; /^FRONTEND_PORT=/d; /^LIVEKIT_PUBLIC_URL=/d' .env
printf '\nFRONTEND_BIND=127.0.0.1\nFRONTEND_PORT=5180\nLIVEKIT_PUBLIC_URL=wss://%s/livekit\n' "$ip" >> .env
docker compose up -d --build backend frontend voice-agent

sed "s/@IP@/$ip/g" infrastructure/https/nginx.conf.template > /etc/nginx/sites-available/assistant
ln -sf /etc/nginx/sites-available/assistant /etc/nginx/sites-enabled/assistant
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
curl --fail --silent --show-error "https://$ip/api/conversations"
printf '\nReady: https://%s\n' "$ip"
