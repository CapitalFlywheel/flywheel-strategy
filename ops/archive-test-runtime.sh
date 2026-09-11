#!/usr/bin/env bash
set -Eeuo pipefail

app_dir=/opt/mstr-system
archive_root=/opt/mstr-system-test-archive
archive_name="${1:-}"

if [ "${CONFIRM_ARCHIVE_TEST_RUNTIME:-}" != "YES" ]; then
  echo "Set CONFIRM_ARCHIVE_TEST_RUNTIME=YES to continue." >&2
  exit 2
fi
if [ "$app_dir" != "/opt/mstr-system" ] || [ -z "$archive_name" ]; then
  echo "Unsafe or missing cleanup target." >&2
  exit 2
fi
if [[ ! "$archive_name" =~ ^[0-9]{8}-[0-9]{6}$ ]]; then
  echo "Archive name must use YYYYMMDD-HHMMSS." >&2
  exit 2
fi

archive_dir="$archive_root/$archive_name"
if [ -e "$archive_dir" ]; then
  echo "Archive already exists: $archive_dir" >&2
  exit 2
fi

sudo systemctl stop mstr-control-runner.service
runner_stopped=true
restore_runner() {
  if [ "${runner_stopped:-false}" = true ]; then
    sudo systemctl start mstr-control-runner.service || true
  fi
}
trap restore_runner EXIT

cd "$app_dir"
docker compose stop reward-keeper reward-publisher governance-keeper launch-watcher >/dev/null 2>&1 || true

sudo install -d -m 0750 -o mstradmin -g mstradmin "$archive_root" "$archive_dir"
if [ -f .env.server ]; then
  install -m 0600 .env.server "$archive_dir/.env.server.test-backup"
fi
if [ -d data ]; then
  mv data "$archive_dir/data"
fi
if [ -d deployments ]; then
  mv deployments "$archive_dir/deployments"
fi

sudo install -d -m 0750 -o mstradmin -g mstradmin "$archive_dir/server-backups"
if sudo test -d /var/backups/mstr-system; then
  sudo find /var/backups/mstr-system -maxdepth 1 -type f -name 'data-*.tar.gz' \
    -exec mv -t "$archive_dir/server-backups" -- {} +
  sudo chown -R mstradmin:mstradmin "$archive_dir/server-backups"
fi

install -d -m 0750 data data/public data/public/snapshots data/public/status data/public/governance data/control deployments

if [ -f .env.server ]; then
  runtime_keys='^(LAUNCHER_ADDRESS|TEAM_ADDRESS|FINAL_ADMIN_ADDRESS|MARKETING_WALLET_ADDRESS|TEST_HOLDER_1_ADDRESS|TEST_HOLDER_2_ADDRESS|TEST_HOLDER_3_ADDRESS|TOKEN_NAME|TOKEN_SYMBOL|TOKEN_DESCRIPTION|MAINNET_TEST_BUDGET_WEI|REWARD_VAULT_ADDRESS|RESERVE_VAULT_ADDRESS|KEEPER_VAULT_ADDRESS|FEE_ROUTER_ADDRESS|PONS_FEE_COLLECTOR_ADDRESS|V4_MSTR_ADAPTER_ADDRESS|V3_MSTR_ADAPTER_ADDRESS|VITE_REWARD_VAULT_ADDRESS|VITE_RESERVE_VAULT_ADDRESS|PROJECT_TOKEN_ADDRESS|PROJECT_CURVE_ADDRESS|PROJECT_LAUNCH_BLOCK|PROJECT_LAUNCH_TIMESTAMP|GOVERNANCE_ADDRESS|RESTRICTED_EXECUTOR_ADDRESS|RESERVE_ACTION_ADAPTER_ADDRESS|PROJECT_HOLD_VAULT_ADDRESS|PROJECT_TOKEN_LOCK_VAULT_ADDRESS|VITE_GOVERNANCE_ADDRESS)='
  env_tmp="$(mktemp "$app_dir/.env.server.clean.XXXXXX")"
  grep -Ev "$runtime_keys" .env.server >"$env_tmp"
  chmod 0600 "$env_tmp"
  mv "$env_tmp" .env.server
fi

docker compose build web
docker compose up -d web

sudo systemctl start mstr-control-runner.service
runner_stopped=false
trap - EXIT

echo "TEST_RUNTIME_ARCHIVED=$archive_dir"
