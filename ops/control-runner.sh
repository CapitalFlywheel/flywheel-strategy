#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/mstr-system"
CONTROL_DIR="$APP_DIR/data/control"
REQUEST_DIR="$CONTROL_DIR/requests"
PROCESSING_DIR="$CONTROL_DIR/processing"
ARCHIVE_DIR="$CONTROL_DIR/archive"
STATUS_FILE="$CONTROL_DIR/status.json"
LAST_ACTION_FILE="$CONTROL_DIR/last-action.json"
MAIN_LAUNCH_DIR="$CONTROL_DIR/main-launch"

mkdir -p "$REQUEST_DIR" "$PROCESSING_DIR" "$ARCHIVE_DIR" "$MAIN_LAUNCH_DIR"
chmod 700 "$CONTROL_DIR" "$REQUEST_DIR" "$PROCESSING_DIR" "$ARCHIVE_DIR" "$MAIN_LAUNCH_DIR"

service_running() {
  local service="$1"
  [[ "$(cd "$APP_DIR" && docker compose ps --status running --services "$service" 2>/dev/null)" == "$service" ]]
}

write_status() {
  local reward_keeper=false
  local reward_publisher=false
  local governance_keeper=false
  service_running reward-keeper && reward_keeper=true
  service_running reward-publisher && reward_publisher=true
  service_running governance-keeper && governance_keeper=true

  local state="partial"
  if [[ "$reward_keeper" == true && "$reward_publisher" == true && "$governance_keeper" == true ]]; then
    state="running"
  elif [[ "$reward_keeper" == false && "$reward_publisher" == false && "$governance_keeper" == false ]]; then
    state="stopped"
  fi

  python3 - "$STATUS_FILE" "$LAST_ACTION_FILE" "$state" "$reward_keeper" "$reward_publisher" "$governance_keeper" <<'PY'
import json
import os
import sys
import tempfile
import time

status_path, last_path, state, reward_keeper, reward_publisher, governance_keeper = sys.argv[1:]
last_action = None
try:
    with open(last_path, "r", encoding="utf8") as stream:
        last_action = json.load(stream)
except (FileNotFoundError, json.JSONDecodeError):
    pass

payload = {
    "automationState": state,
    "services": {
        "reward-keeper": reward_keeper == "true",
        "reward-publisher": reward_publisher == "true",
        "governance-keeper": governance_keeper == "true",
    },
    "updatedAt": int(time.time() * 1000),
    "lastAction": last_action,
}
directory = os.path.dirname(status_path)
fd, temporary = tempfile.mkstemp(prefix="status-", suffix=".json", dir=directory)
with os.fdopen(fd, "w", encoding="utf8") as stream:
    json.dump(payload, stream)
os.chmod(temporary, 0o600)
os.replace(temporary, status_path)
PY
}

process_request() {
  local source="$1"
  local name
  name="$(basename "$source")"
  local processing="$PROCESSING_DIR/$name"
  mv "$source" "$processing"

  local action
  if ! action="$(python3 - "$processing" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf8") as stream:
    payload = json.load(stream)
action = payload.get("action")
if action not in {
    "start_automation", "stop_automation", "register_prelaunch", "arm_launch_detection",
    "cancel_launch_detection", "activate_postlaunch", "prepare_governance"
}:
    raise SystemExit(1)
print(action)
PY
  )"; then
    mv "$processing" "$ARCHIVE_DIR/rejected-$name"
    return
  fi

  local result="success"
  if [[ "$action" == "start_automation" ]]; then
    if ! (cd "$APP_DIR" && docker compose start reward-keeper reward-publisher governance-keeper); then
      result="failed"
    fi
  elif [[ "$action" == "stop_automation" ]]; then
    if ! (cd "$APP_DIR" && docker compose stop reward-keeper reward-publisher governance-keeper); then
      result="failed"
    fi
  elif [[ "$action" == "register_prelaunch" ]]; then
    if ! (cd "$APP_DIR" && docker compose run --rm --no-deps web npx tsx scripts/verify-admin-manifest.ts "/app/data/control/processing/$name"); then
      result="failed"
    elif ! python3 - "$processing" "$MAIN_LAUNCH_DIR/prelaunch.json" <<'PY'
import json, os, sys, tempfile
source, target = sys.argv[1:]
with open(source, "r", encoding="utf8") as stream:
    payload = json.load(stream)["payload"]
directory = os.path.dirname(target)
fd, temporary = tempfile.mkstemp(prefix="prelaunch-", suffix=".json", dir=directory)
with os.fdopen(fd, "w", encoding="utf8") as stream:
    json.dump(payload, stream, indent=2)
os.chmod(temporary, 0o600)
os.replace(temporary, target)
PY
    then
      result="failed"
    fi
  elif [[ "$action" == "arm_launch_detection" ]]; then
    if [[ ! -f "$MAIN_LAUNCH_DIR/prelaunch.json" || -f "$MAIN_LAUNCH_DIR/detected.json" ]]; then
      result="failed"
    else
      python3 - "$MAIN_LAUNCH_DIR/armed.json" <<'PY'
import json, os, sys, time
with open(sys.argv[1], "w", encoding="utf8") as stream:
    json.dump({"armedAt": int(time.time() * 1000)}, stream)
os.chmod(sys.argv[1], 0o600)
PY
      (cd "$APP_DIR" && docker compose up -d launch-watcher) || result="failed"
    fi
  elif [[ "$action" == "cancel_launch_detection" ]]; then
    (cd "$APP_DIR" && docker compose stop launch-watcher) || result="failed"
    if [[ -f "$MAIN_LAUNCH_DIR/armed.json" ]]; then
      mv "$MAIN_LAUNCH_DIR/armed.json" "$ARCHIVE_DIR/cancelled-armed-$(date +%s).json"
    fi
  elif [[ "$action" == "activate_postlaunch" ]]; then
    if ! (cd "$APP_DIR" && docker compose run --rm --no-deps web npx tsx scripts/verify-admin-manifest.ts "/app/data/control/processing/$name"); then
      result="failed"
    elif ! python3 "$APP_DIR/ops/activate-postlaunch.py" "$processing"; then
      result="failed"
    else
      (cd "$APP_DIR" && docker compose up -d reward-keeper reward-publisher governance-keeper) || result="failed"
    fi
  elif [[ "$action" == "prepare_governance" ]]; then
    if [[ ! -f "$MAIN_LAUNCH_DIR/postlaunch.json" ]]; then
      result="failed"
    elif ! (cd "$APP_DIR" && docker compose run --rm --no-deps --env-from-file .env.server web \
      npx tsx services/admin/prepareGovernance.ts "/app/data/control/processing/$name"); then
      result="failed"
    fi
  fi

  python3 - "$LAST_ACTION_FILE" "$action" "$result" <<'PY'
import json
import os
import sys
import time

path, action, result = sys.argv[1:]
with open(path, "w", encoding="utf8") as stream:
    json.dump({"action": action, "result": result, "completedAt": int(time.time() * 1000)}, stream)
os.chmod(path, 0o600)
PY
  mv "$processing" "$ARCHIVE_DIR/$name"
}

while true; do
  shopt -s nullglob
  requests=("$REQUEST_DIR"/*.json)
  shopt -u nullglob
  for request in "${requests[@]}"; do
    process_request "$request"
  done
  write_status
  sleep 2
done
