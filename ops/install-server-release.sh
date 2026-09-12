#!/usr/bin/env bash
set -Eeuo pipefail

release_archive=/tmp/mstr-system-server.tar.gz
release_dir=/tmp/mstr-system-release
app_dir=/opt/mstr-system

if [ ! -f "$release_archive" ]; then
  echo "Release archive is missing." >&2
  exit 1
fi
if [ "$release_dir" != "/tmp/mstr-system-release" ]; then
  echo "Unsafe release directory." >&2
  exit 1
fi

rm -rf "$release_dir"
install -d -m 0750 -o mstradmin -g mstradmin "$release_dir" "$app_dir"
tar -xzf "$release_archive" -C "$release_dir"

rsync -a --delete --exclude data --exclude '.env*' "$release_dir/" "$app_dir/"
install -d -m 0750 -o mstradmin -g mstradmin \
  "$app_dir/data" \
  "$app_dir/data/public" \
  "$app_dir/data/public/snapshots" \
  "$app_dir/data/public/status" \
  "$app_dir/data/control"
if [ ! -f "$app_dir/data/reward-state.json" ] && [ -d "$release_dir/data" ]; then
  rsync -a "$release_dir/data/" "$app_dir/data/"
fi

install -m 0600 -o mstradmin -g mstradmin /tmp/.env "$app_dir/.env.server"
for file in .env.web .env.reward-keeper .env.reward-publisher .env.governance-keeper; do
  if [ ! -f "$app_dir/$file" ]; then
    install -m 0600 -o mstradmin -g mstradmin /dev/null "$app_dir/$file"
  fi
done

chown -R mstradmin:mstradmin "$app_dir"
chmod +x "$app_dir/ops/"*.sh

if [ ! -f /etc/nginx/sites-available/mstr-system ]; then
  install -m 0644 /tmp/nginx-ip.conf /etc/nginx/sites-available/mstr-system
fi
ln -sfn /etc/nginx/sites-available/mstr-system /etc/nginx/sites-enabled/mstr-system
if [ -L /etc/nginx/sites-enabled/default ]; then
  unlink /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl reload nginx

install -m 0644 "$app_dir/ops/mstr-backup.service" /etc/systemd/system/mstr-backup.service
install -m 0644 "$app_dir/ops/mstr-backup.timer" /etc/systemd/system/mstr-backup.timer
systemctl daemon-reload
systemctl enable --now mstr-backup.timer

cd "$app_dir"
docker compose config --quiet
docker compose build web
docker compose up -d web

for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8787/ >/dev/null; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    docker compose logs --tail=100 web
    exit 1
  fi
  sleep 2
done

docker compose ps
if curl -fsS http://127.0.0.1:8787/config.json >/tmp/mstr-runtime-config.json; then
  jq '{projectToken, rewardVault, reserveVault, governance}' /tmp/mstr-runtime-config.json
else
  echo "Runtime config is empty. The server is ready for a new launch."
fi
