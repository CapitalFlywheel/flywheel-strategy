#!/usr/bin/env python3
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

APP_DIR = Path("/opt/mstr-system").resolve()
CONTROL_DIR = APP_DIR / "data" / "control" / "main-launch"
PUBLIC_DIR = APP_DIR / "data" / "public"


def atomic_json(path: Path, payload: object, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f"{path.name}-", suffix=".tmp", dir=path.parent)
    with os.fdopen(fd, "w", encoding="utf8") as stream:
        json.dump(payload, stream, indent=2)
        stream.write("\n")
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def update_env(path: Path, values: dict[str, str]) -> None:
    existing = path.read_text(encoding="utf8").splitlines() if path.exists() else []
    kept = [line for line in existing if not line or line.split("=", 1)[0] not in values]
    kept.extend(f"{key}={value}" for key, value in values.items())
    temporary = path.with_suffix(".server.next")
    temporary.write_text("\n".join(kept) + "\n", encoding="utf8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def archive_runtime(timestamp: str) -> None:
    backup = CONTROL_DIR / "backups" / timestamp
    backup.mkdir(parents=True, exist_ok=False)
    fixed_targets = [
        APP_DIR / "data" / "reward-state.json",
        APP_DIR / "data" / "reward-recovery.json",
        APP_DIR / "data" / "transfer-events.json",
        APP_DIR / "data" / "governance-transfer-events.json",
        PUBLIC_DIR / "config.json",
        PUBLIC_DIR / "snapshots",
        PUBLIC_DIR / "governance",
        PUBLIC_DIR / "status",
    ]
    for target in fixed_targets:
        resolved = target.resolve()
        if APP_DIR not in resolved.parents or not target.exists():
            continue
        shutil.move(str(target), str(backup / target.name))


def main() -> None:
    if len(sys.argv) != 2:
        raise RuntimeError("REQUEST_PATH_REQUIRED")
    request_path = Path(sys.argv[1]).resolve()
    processing_root = (APP_DIR / "data" / "control" / "processing").resolve()
    if processing_root not in request_path.parents:
        raise RuntimeError("UNSAFE_REQUEST_PATH")
    request = json.loads(request_path.read_text(encoding="utf8"))
    if request.get("action") != "activate_postlaunch":
        raise RuntimeError("WRONG_ACTION")
    payload = request["payload"]
    detected = json.loads((CONTROL_DIR / "detected.json").read_text(encoding="utf8"))
    if payload["projectToken"].lower() != detected["token"].lower() or payload["curve"].lower() != detected["curve"].lower():
        raise RuntimeError("DETECTED_TOKEN_MISMATCH")

    timestamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    archive_runtime(timestamp)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    runtime = {
        "chainId": 4663,
        "projectToken": payload["projectToken"],
        "mstr": payload["mstr"],
        "rewardVault": payload["rewardVault"],
        "reserveVault": payload["reserveVault"],
        "keeperVault": payload["keeperVault"],
        "feeRouter": payload["feeRouter"],
        "ponsFeeCollector": payload["ponsFeeCollector"],
        "governance": payload["governance"],
        "restrictedExecutor": payload["restrictedExecutor"],
        "projectHoldVault": payload["projectHoldVault"],
        "projectTokenLockVault": payload["projectTokenLockVault"],
        "marketingWallet": payload["marketingWallet"],
        "team": payload["team"],
        "finalAdmin": payload["finalAdmin"],
    }
    atomic_json(PUBLIC_DIR / "config.json", runtime, 0o644)
    atomic_json(CONTROL_DIR / "postlaunch.json", {**payload, "activatedAt": int(time.time() * 1000)})
    update_env(APP_DIR / ".env.server", {
        "AUTOMATION_ADDRESS": payload["automation"],
        "ROOT_PUBLISHER_ADDRESS": payload["rootPublisher"],
        "FINAL_ADMIN_ADDRESS": payload["finalAdmin"],
        "MARKETING_WALLET_ADDRESS": payload["marketingWallet"],
        "GOVERNANCE_ADDRESS": payload["governance"],
        "TEAM_ADDRESS": payload["team"],
        "PROJECT_TOKEN_ADDRESS": payload["projectToken"],
        "PROJECT_CURVE_ADDRESS": payload["curve"],
        "PROJECT_LAUNCH_BLOCK": str(detected["blockNumber"]),
        "PROJECT_LAUNCH_TIMESTAMP": str(detected["launchTimestamp"]),
        "PONS_FEE_COLLECTOR_ADDRESS": payload["ponsFeeCollector"],
        "LAUNCHER_ADDRESS": payload["owner"],
        "FEE_ROUTER_ADDRESS": payload["feeRouter"],
        "V4_MSTR_ADAPTER_ADDRESS": payload["v4MstrAdapter"],
        "V3_MSTR_ADAPTER_ADDRESS": payload["v3MstrAdapter"],
        "RESTRICTED_EXECUTOR_ADDRESS": payload["restrictedExecutor"],
        "RESERVE_ACTION_ADAPTER_ADDRESS": payload["reserveActionAdapter"],
        "PROJECT_HOLD_VAULT_ADDRESS": payload["projectHoldVault"],
        "PROJECT_TOKEN_LOCK_VAULT_ADDRESS": payload["projectTokenLockVault"],
        "REWARD_VAULT_ADDRESS": payload["rewardVault"],
        "RESERVE_VAULT_ADDRESS": payload["reserveVault"],
        "KEEPER_VAULT_ADDRESS": payload["keeperVault"],
    })
    print("POSTLAUNCH_ACTIVATED")


if __name__ == "__main__":
    main()
