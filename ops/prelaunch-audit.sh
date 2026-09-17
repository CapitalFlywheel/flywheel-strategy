#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/mstr-system}"
cd "$APP_DIR"

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }

if systemctl is-active --quiet mstr-control-runner.service; then
  pass "control runner is active"
else
  fail "control runner is not active"
fi

if systemctl is-enabled --quiet mstr-control-runner.service; then
  pass "control runner starts after reboot"
else
  fail "control runner is not enabled"
fi

if curl --fail --silent --show-error http://127.0.0.1:8787/health >/dev/null; then
  pass "web health endpoint responds"
else
  fail "web health endpoint failed"
fi

if [[ -x ops/control-runner.sh && -x ops/backup-data.sh ]]; then
  pass "systemd shell scripts are executable"
else
  fail "one or more systemd shell scripts are not executable"
fi

for secret_file in .env.server .env.reward-keeper .env.reward-publisher .env.governance-keeper; do
  if [[ ! -f "$secret_file" ]]; then
    fail "$secret_file is missing"
  elif [[ "$(stat -c '%a' "$secret_file")" != "600" ]]; then
    fail "$secret_file is not mode 600"
  else
    pass "$secret_file exists with mode 600"
  fi
done

if grep -qs '^DEPLOYER_PRIVATE_KEY=' .env*; then
  fail "production deployer key is present on the server"
else
  pass "production deployer key is absent"
fi

postlaunch="data/control/main-launch/postlaunch.json"
running_bots="$(docker compose ps --status running --services reward-keeper reward-publisher governance-keeper 2>/dev/null || true)"
if [[ -f "$postlaunch" ]]; then
  [[ "$(printf '%s\n' "$running_bots" | sed '/^$/d' | wc -l)" -eq 3 ]] \
    && pass "all automation services are running after activation" \
    || fail "postlaunch exists but not all automation services are running"
else
  [[ -z "$running_bots" ]] \
    && pass "automation is stopped before activation" \
    || fail "automation is running before activation"
fi

if systemctl show mstr-backup.service -p Result --value | grep -qx success; then
  pass "latest backup service run succeeded"
else
  fail "latest backup service run did not succeed"
fi

available_kb="$(df --output=avail / | tail -n 1 | tr -d ' ')"
if [[ "$available_kb" -ge 10485760 ]]; then
  pass "at least 10 GiB disk space is available"
else
  fail "less than 10 GiB disk space is available"
fi

if docker compose run --rm --no-deps --env-from-file .env.server web npm run verify:live; then
  pass "live Robinhood configuration verification passed"
else
  fail "live Robinhood configuration verification failed"
fi

if docker compose run --rm --no-deps web npm run security:secrets; then
  pass "repository secret scan passed"
else
  fail "repository secret scan failed"
fi

if [[ "$failures" -ne 0 ]]; then
  printf '\nPRELAUNCH AUDIT FAILED: %s check(s) failed\n' "$failures" >&2
  exit 1
fi

printf '\nPRELAUNCH AUDIT PASSED\n'
