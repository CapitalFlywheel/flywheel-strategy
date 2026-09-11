#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/mstr-system"
ENV_FILE="$APP_DIR/.env.server"

if [[ ! -d "$APP_DIR" || ! -f "$ENV_FILE" ]]; then
  echo "Project configuration was not found in $APP_DIR."
  exit 1
fi

validate_rpc() {
  local label="$1"
  local endpoint="$2"

  if [[ "$endpoint" != https://* ]]; then
    echo "$label must be a full HTTPS endpoint."
    return 1
  fi

  python3 - "$label" 3<<<"$endpoint" <<'PY'
import json
import os
import sys
import urllib.request

label = sys.argv[1]
with os.fdopen(3) as stream:
    endpoint = stream.read().strip()

def rpc(method):
    request = urllib.request.Request(
        endpoint,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": []}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        payload = json.load(response)
    if payload.get("error") or not payload.get("result"):
        raise RuntimeError(payload.get("error", {}).get("message", "RPC returned no result"))
    return payload["result"]

try:
    chain_id = int(rpc("eth_chainId"), 16)
    block_number = int(rpc("eth_blockNumber"), 16)
except Exception as error:
    print(f"{label} check failed: {error}", file=sys.stderr)
    raise SystemExit(1)

if chain_id != 4663:
    print(f"{label} is connected to chain {chain_id}, not Robinhood Chain Mainnet 4663.", file=sys.stderr)
    raise SystemExit(1)

print(f"{label} is ready. Current block: {block_number}.")
PY
}

echo "RPC setup for Robinhood Chain Mainnet"
echo "The endpoint addresses are hidden while you paste them."
echo

read -r -s -p "Paste the full Alchemy HTTPS endpoint: " primary_rpc
echo
read -r -s -p "Paste the full backup HTTPS endpoint: " fallback_rpc
echo

if [[ -z "$primary_rpc" || -z "$fallback_rpc" ]]; then
  echo "Both Alchemy and backup endpoints are required."
  exit 1
fi

echo "Checking Alchemy..."
validate_rpc "Alchemy" "$primary_rpc"
echo "Checking backup RPC..."
validate_rpc "Backup RPC" "$fallback_rpc"

temp_file="$(mktemp "$APP_DIR/.env.server.rpc.XXXXXX")"
trap 'rm -f "$temp_file"' EXIT
chmod 600 "$temp_file"

awk '!/^ROBINHOOD_RPC_URL=/ && !/^ROBINHOOD_RPC_FALLBACK_URL=/' "$ENV_FILE" > "$temp_file"
printf 'ROBINHOOD_RPC_URL=%s\n' "$primary_rpc" >> "$temp_file"
printf 'ROBINHOOD_RPC_FALLBACK_URL=%s\n' "$fallback_rpc" >> "$temp_file"
mv "$temp_file" "$ENV_FILE"
chmod 600 "$ENV_FILE"
trap - EXIT

unset primary_rpc fallback_rpc

cd "$APP_DIR"
docker compose up -d --force-recreate reward-keeper reward-publisher governance-keeper

echo
echo "RPC ENDPOINTS INSTALLED. ALCHEMY IS PRIMARY; BACKUP RPC IS READY."
docker compose ps reward-keeper reward-publisher governance-keeper
