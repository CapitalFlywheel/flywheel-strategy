#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="${1:-/opt/mstr-system/.env.server}"
rpc_url="$(sed -n 's/^ROBINHOOD_RPC_URL=//p' "$ENV_FILE" | tail -n 1)"

if [[ -z "$rpc_url" ]]; then
  echo "Primary RPC is not configured."
  exit 1
fi

response="$(curl -fsS -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  "$rpc_url")"

if [[ "$response" != *'0x1237'* ]]; then
  echo "Primary RPC did not return Robinhood Chain 4663."
  exit 1
fi

echo "PRIMARY_RPC_OK chain=4663"
