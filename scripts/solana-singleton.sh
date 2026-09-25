#!/bin/sh
set -eu

# The lock file is deliberately never removed: flock locks the inode, not the
# pathname. Deleting a live lock file could allow two runners to enter.
if [ "$#" -ne 1 ]; then
  echo "SOLANA_SINGLETON_SERVICE_REQUIRED" >&2
  exit 64
fi

case "$1" in
  control-runner)
    service=control-runner
    entry=services/solana/controlRunner.ts
    ;;
  holder-indexer)
    service=holder-indexer
    entry=services/solana/holderIndexerRunner.ts
    ;;
  test-probe)
    if [ "${NODE_ENV:-}" != test ]; then
      echo "SOLANA_SINGLETON_TEST_ONLY" >&2
      exit 64
    fi
    service=control-runner
    entry=
    ;;
  *)
    echo "SOLANA_SINGLETON_SERVICE_INVALID" >&2
    exit 64
    ;;
esac

if ! command -v flock >/dev/null 2>&1; then
  echo "SOLANA_SINGLETON_FLOCK_UNAVAILABLE" >&2
  exit 78
fi

state_root=${SOLANA_STATE_ROOT:-data/solana}
lock_root="$state_root/.locks"
mkdir -p "$lock_root"
lock_file="$lock_root/$service.lock"
exec 9>>"$lock_file"

# A bounded wait makes a second instance visible in logs, without a restart
# storm. Errors other than contention fail closed instead of waiting forever.
while true; do
  if flock -E 75 -x -w 15 9; then
    break
  else
    result=$?
    if [ "$result" -ne 75 ]; then
      echo "SOLANA_SINGLETON_LOCK_ERROR:$service:$result" >&2
      exit 78
    fi
    echo "SOLANA_SINGLETON_WAITING:$service" >&2
    sleep 5
  fi
done

echo "SOLANA_SINGLETON_ACQUIRED:$service" >&2
export SOLANA_SINGLETON_GUARD="$service"
if [ "$1" = test-probe ]; then
  exec flock -F -n 9 node -e 'setTimeout(() => {}, Number(process.env.SOLANA_SINGLETON_PROBE_MS || "1000"))'
fi
exec flock -F -n 9 node --import tsx "$entry"
