#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/mstr-system
umask 077

read -rsp "Paste AUTOMATION wallet private key (hidden): " automation_key
printf '\n'
read -rsp "Paste REWARDS wallet private key (hidden): " publisher_key
printf '\n'

if [[ ! "$automation_key" =~ ^(0x)?[0-9a-fA-F]{64}$ ]]; then
  echo "Invalid AUTOMATION private key format." >&2
  exit 1
fi
if [[ ! "$publisher_key" =~ ^(0x)?[0-9a-fA-F]{64}$ ]]; then
  echo "Invalid REWARDS private key format." >&2
  exit 1
fi

[[ "$automation_key" == 0x* ]] || automation_key="0x${automation_key}"
[[ "$publisher_key" == 0x* ]] || publisher_key="0x${publisher_key}"

printf 'KEEPER_PRIVATE_KEY=%s\n' "$automation_key" > .env.reward-keeper
printf 'KEEPER_PRIVATE_KEY=%s\n' "$automation_key" > .env.governance-keeper
printf 'ROOT_PUBLISHER_PRIVATE_KEY=%s\n' "$publisher_key" > .env.reward-publisher
chmod 600 .env.reward-keeper .env.governance-keeper .env.reward-publisher

unset automation_key publisher_key

docker compose up -d reward-keeper reward-publisher governance-keeper
docker compose ps

echo "BOT SECRETS INSTALLED. AUTOMATION IS RUNNING."
